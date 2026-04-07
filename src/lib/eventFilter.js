export function isAllowedEventItem(item, now = new Date()) {
  if (!item.eventDate) {
    return false;
  }

  const eventDate = new Date(item.eventDate);

  if (Number.isNaN(eventDate.getTime())) {
    return false;
  }

  const { from, to } = getAllowedEventWindow(now);
  return eventDate >= from && eventDate <= to;
}

export function getAllowedEventWindow(now = new Date()) {
  const month = process.env.EVENT_TARGET_MONTH || "2026-04";
  const [year, monthNumber] = month.split("-").map(Number);
  const monthIndex = monthNumber - 1;
  const configuredFrom = process.env.EVENTS_ALLOWED_FROM ? new Date(process.env.EVENTS_ALLOWED_FROM) : null;
  const configuredTo = process.env.EVENTS_ALLOWED_TO ? new Date(process.env.EVENTS_ALLOWED_TO) : null;
  const monthStart = new Date(Date.UTC(year, monthIndex, 1, -3, 0, 0));
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 1, -3, 0, 0) - 1);
  const today = startOfMoscowDay(now);

  return {
    from: validDate(configuredFrom) || maxDate(today, monthStart),
    to: validDate(configuredTo) || monthEnd
  };
}

export function getAllowedEventWindowLabel(now = new Date()) {
  const { from, to } = getAllowedEventWindow(now);

  return `${from.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })} - ${to.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}`;
}

function startOfMoscowDay(now) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const [year, month, day] = formatter.format(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, -3, 0, 0));
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function validDate(date) {
  return date && !Number.isNaN(date.getTime()) ? date : null;
}
