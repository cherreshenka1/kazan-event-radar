import fs from "node:fs/promises";

export async function buildLocalSnapshotPayload(outputPath, payload = {}, options = {}) {
  const nextItems = sanitizeSnapshotItems(payload.items || []);
  const mode = String(options.mode || "").toLowerCase();

  if (mode !== "incremental") {
    return {
      ...payload,
      snapshotMode: "replace",
      newItemsCount: nextItems.length,
      retainedItemsCount: 0,
      reportedImportedCount: nextItems.length,
      items: nextItems
    };
  }

  const previousItems = await readPreviousSnapshotItems(outputPath);
  const mergedItems = mergeSnapshotItems(previousItems, nextItems);

  return {
    ...payload,
    snapshotMode: "incremental_merge",
    newItemsCount: nextItems.length,
    retainedItemsCount: Math.max(0, mergedItems.length - nextItems.length),
    reportedImportedCount: mergedItems.length,
    items: mergedItems
  };
}

async function readPreviousSnapshotItems(outputPath) {
  try {
    const raw = await fs.readFile(outputPath, "utf8");
    const payload = JSON.parse(raw);
    return Array.isArray(payload?.items) ? payload.items : [];
  } catch {
    return [];
  }
}

function mergeSnapshotItems(previousItems, nextItems) {
  const merged = new Map();

  for (const item of sanitizeSnapshotItems(previousItems)) {
    merged.set(buildSnapshotItemKey(item), item);
  }

  for (const item of sanitizeSnapshotItems(nextItems)) {
    const key = buildSnapshotItemKey(item);
    const current = merged.get(key);
    merged.set(key, current ? mergeSnapshotItemFields(current, item) : item);
  }

  return sortSnapshotItems([...merged.values()]);
}

function sanitizeSnapshotItems(items) {
  return sortSnapshotItems(
    dedupeSnapshotItems(items)
      .filter(shouldKeepSnapshotItem)
  );
}

function dedupeSnapshotItems(items) {
  const grouped = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const key = buildSnapshotItemKey(item);
    const current = grouped.get(key);

    if (!current) {
      grouped.set(key, item);
      continue;
    }

    grouped.set(key, mergeSnapshotItemFields(current, item));
  }

  return [...grouped.values()];
}

function buildSnapshotItemKey(item) {
  const sourceUrl = normalizeText(item?.url).toLowerCase();
  if (sourceUrl) return `url::${sourceUrl}`;

  return [
    normalizeText(item?.title).toLowerCase(),
    normalizeText(item?.eventDate).slice(0, 16),
    normalizeText(item?.venueTitle).toLowerCase()
  ].join("::");
}

function mergeSnapshotItemFields(previous, next) {
  return {
    ...previous,
    ...next,
    sourceId: next?.sourceId || previous?.sourceId || "",
    sourceName: next?.sourceName || previous?.sourceName || "",
    title: pickString(next?.title, previous?.title),
    subtitle: pickString(next?.subtitle, previous?.subtitle, { preferLonger: true }),
    summary: pickString(next?.summary, previous?.summary, { preferLonger: true }),
    shortSummary: pickString(next?.shortSummary, previous?.shortSummary, { preferLonger: true }),
    imageUrl: next?.imageUrl || previous?.imageUrl || "",
    venueTitle: pickString(next?.venueTitle, previous?.venueTitle),
    venueUrl: next?.venueUrl || previous?.venueUrl || "",
    sourceLabel: next?.sourceLabel || previous?.sourceLabel || "",
    section: next?.section || previous?.section || "events",
    url: next?.url || previous?.url || "",
    eventDate: next?.eventDate || previous?.eventDate || null,
    eventHasExplicitTime: Boolean(next?.eventHasExplicitTime || previous?.eventHasExplicitTime),
    dateText: pickString(next?.dateText, previous?.dateText)
  };
}

function pickString(preferred, fallback, options = {}) {
  const preferredText = normalizeText(preferred);
  const fallbackText = normalizeText(fallback);

  if (!preferredText) return fallbackText;
  if (!fallbackText) return preferredText;
  if (!options.preferLonger) return preferredText;

  return preferredText.length >= fallbackText.length ? preferredText : fallbackText;
}

function shouldKeepSnapshotItem(item) {
  const eventDate = new Date(item?.eventDate || "");
  if (Number.isNaN(eventDate.getTime())) return false;

  return eventDate >= getStartOfTodayInMoscow() && eventDate <= getEndOfCurrentYearInMoscow();
}

function getStartOfTodayInMoscow() {
  const parts = getMoscowCalendarParts(new Date());
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, -3, 0, 0, 0));
}

function getEndOfCurrentYearInMoscow() {
  const parts = getMoscowCalendarParts(new Date());
  return new Date(Date.UTC(parts.year, 11, 31, 20, 59, 59, 999));
}

function getMoscowCalendarParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value || 0),
    month: Number(parts.find((part) => part.type === "month")?.value || 0),
    day: Number(parts.find((part) => part.type === "day")?.value || 0)
  };
}

function sortSnapshotItems(items) {
  return [...items].sort((left, right) => {
    const leftTime = new Date(left?.eventDate || "").getTime();
    const rightTime = new Date(right?.eventDate || "").getTime();

    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return normalizeText(left?.title).localeCompare(normalizeText(right?.title), "ru");
  });
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
