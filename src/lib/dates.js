export function isWithinDays(item, days) {
  const date = getItemDate(item);

  if (!date) {
    return days >= 7;
  }

  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return date >= startOfDay(now) && date <= end;
}

export function getItemDate(item) {
  const value = item.eventDate || item.publishedAt || item.date;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
