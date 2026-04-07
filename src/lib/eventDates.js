const MONTHS = {
  января: 0,
  феврал: 1,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11
};

export function extractEventDate(item, now = new Date()) {
  const text = `${item.title || ""}\n${item.summary || ""}`.toLowerCase();
  const time = extractTime(text);
  const relative = extractRelativeDate(text, now, time);

  if (relative) {
    return relative;
  }

  const match = text.match(/(?:^|\D)(\d{1,2})(?:\s*(?:-|–|—|и)\s*\d{1,2})?\s+(января|феврал[ья]|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/u);

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = MONTHS[match[2]];
  const year = match[3] ? Number(match[3]) : inferYear(month, day, now);

  return toMoscowIso(year, month, day, time.hour, time.minute);
}

function extractRelativeDate(text, now, time) {
  const base = new Date(now);

  if (text.includes("сегодня")) {
    return toMoscowIso(base.getFullYear(), base.getMonth(), base.getDate(), time.hour, time.minute);
  }

  if (text.includes("завтра")) {
    base.setDate(base.getDate() + 1);
    return toMoscowIso(base.getFullYear(), base.getMonth(), base.getDate(), time.hour, time.minute);
  }

  return null;
}

function extractTime(text) {
  const match = text.match(/(?:^|\D)([01]?\d|2[0-3])[:.](\d{2})(?:\D|$)/);

  if (!match) {
    return { hour: 12, minute: 0 };
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2])
  };
}

function inferYear(month, day, now) {
  const year = now.getFullYear();
  const candidate = new Date(year, month, day);
  const monthAgo = new Date(now);
  monthAgo.setDate(monthAgo.getDate() - 30);

  return candidate < monthAgo ? year + 1 : year;
}

function toMoscowIso(year, month, day, hour, minute) {
  const utc = Date.UTC(year, month, day, hour - 3, minute, 0);
  return new Date(utc).toISOString();
}
