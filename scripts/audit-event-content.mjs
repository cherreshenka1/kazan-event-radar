import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REPORT_PATH = path.join(ROOT, "data", "playwright", "content-audit-report.json");
const GENERATED_PREVIEW_DIR = path.join(ROOT, "public", "miniapp", "generated", "events");
const MANIFEST_PATH = path.join(ROOT, "public", "miniapp", "event-preview-manifest.js");
const SNAPSHOT_PATHS = [
  path.join(ROOT, "data", "playwright", "yandex-browser-events.json"),
  path.join(ROOT, "data", "playwright", "mts-live-events.json"),
  path.join(ROOT, "data", "playwright", "kassir-browser-events.json"),
  path.join(ROOT, "data", "playwright", "official-sport-events.json"),
  path.join(ROOT, "data", "playwright", ".tmp", "events_items.json")
];
const EXCLUDED_KEYWORDS = [
  "розыгрыш",
  "авиабилеты",
  "самолет",
  "самолёт"
];

const cliOptions = parseCliOptions(process.argv.slice(2));

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date();
  const from = parseDateBoundary(cliOptions.from, false) || startOfMoscowDay(startedAt);
  const to = parseDateBoundary(cliOptions.to, true) || endOfMoscowYear(startedAt);
  const snapshots = await loadSnapshots();
  const manifest = await loadPreviewManifest();
  const generatedPreviewFiles = await loadGeneratedPreviewFiles();
  const allItems = snapshots.flatMap((snapshot) => snapshot.items);
  const normalizedItems = allItems
    .map((item) => normalizeEventItem(item))
    .filter(Boolean);
  const futureRawItems = normalizedItems.filter((item) => item.eventDate >= from && item.eventDate <= to);
  const rawDuplicateGroups = buildDuplicateGroups(futureRawItems);
  const rawDescriptionDuplicateGroups = buildDuplicateGroups(futureRawItems, "descriptionDuplicateKey");
  const rejectedRawItems = futureRawItems.filter((item) => item.quality.blockedKeyword || item.quality.likelyMojibake || item.quality.blockedLanguage);
  const futureItems = dedupeAuditEventItems(futureRawItems.filter((item) => !rejectedRawItems.includes(item)));
  const eligibleItems = futureItems.filter((item) => !item.quality.blockedKeyword && !item.quality.likelyMojibake && !item.quality.blockedLanguage);
  const duplicateGroups = buildDuplicateGroups(futureItems);
  const descriptionDuplicateGroups = buildDuplicateGroups(futureItems, "descriptionDuplicateKey");
  const previewIssues = buildPreviewIssues(futureItems, manifest, generatedPreviewFiles);
  const textIssues = buildTextIssues(futureItems);
  const channelReadiness = buildChannelReadiness(eligibleItems);
  const byKind = countBy(futureItems, (item) => item.kind || "events");
  const bySource = countBy(futureItems, (item) => item.sourceFile || item.sourceId || "unknown");
  const report = {
    ok: duplicateGroups.length === 0
      && descriptionDuplicateGroups.length === 0
      && previewIssues.missing.length === 0
      && textIssues.blockedKeyword.length === 0
      && textIssues.likelyMojibake.length === 0
      && channelReadiness.ready,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    window: {
      from: from.toISOString(),
      to: to.toISOString()
    },
    totals: {
      snapshots: snapshots.length,
      loadedItems: allItems.length,
      normalizedItems: normalizedItems.length,
      futureRawItems: futureRawItems.length,
      futureItems: futureItems.length,
      eligibleItems: eligibleItems.length,
      rejectedRawItems: rejectedRawItems.length,
      rawDuplicateGroups: rawDuplicateGroups.length,
      rawDescriptionDuplicateGroups: rawDescriptionDuplicateGroups.length,
      duplicateGroups: duplicateGroups.length,
      descriptionDuplicateGroups: descriptionDuplicateGroups.length,
      missingPreviews: previewIssues.missing.length,
      brandedSourceImages: previewIssues.brandedSourceImages.length,
      noCleanSourceImages: previewIssues.noCleanSourceImages.length,
      generatedFallbackPreviews: previewIssues.generatedFallbackPreviews.length,
      weakTextItems: textIssues.weakText.length,
      blockedKeywordItems: textIssues.blockedKeyword.length,
      likelyMojibakeItems: textIssues.likelyMojibake.length
    },
    channelReadiness,
    byKind,
    bySource,
    rawDuplicateGroups: rawDuplicateGroups.slice(0, cliOptions.maxDetails),
    rawDescriptionDuplicateGroups: rawDescriptionDuplicateGroups.slice(0, cliOptions.maxDetails),
    duplicateGroups: duplicateGroups.slice(0, cliOptions.maxDetails),
    descriptionDuplicateGroups: descriptionDuplicateGroups.slice(0, cliOptions.maxDetails),
    previewIssues: {
      ...previewIssues,
      missing: previewIssues.missing.slice(0, cliOptions.maxDetails),
      brandedSourceImages: previewIssues.brandedSourceImages.slice(0, cliOptions.maxDetails),
      noCleanSourceImages: previewIssues.noCleanSourceImages.slice(0, cliOptions.maxDetails),
      generatedFallbackPreviews: previewIssues.generatedFallbackPreviews.slice(0, cliOptions.maxDetails)
    },
    textIssues: {
      weakText: textIssues.weakText.slice(0, cliOptions.maxDetails),
      blockedKeyword: textIssues.blockedKeyword.slice(0, cliOptions.maxDetails),
      likelyMojibake: textIssues.likelyMojibake.slice(0, cliOptions.maxDetails)
    },
    snapshots: snapshots.map((snapshot) => ({
      file: path.relative(ROOT, snapshot.file),
      source: snapshot.source,
      syncedAt: snapshot.syncedAt,
      items: snapshot.items.length
    }))
  };

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  printSummary(report);

  if (cliOptions.strict && !report.ok) {
    process.exitCode = 1;
  }
}

async function loadSnapshots() {
  const snapshots = [];

  for (const filePath of SNAPSHOT_PATHS) {
    try {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
      const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
      snapshots.push({
        file: filePath,
        source: payload?.source || "",
        syncedAt: payload?.syncedAt || null,
        items: items.map((item) => ({
          ...item,
          sourceFile: path.relative(ROOT, filePath)
        }))
      });
    } catch {
      // Missing local snapshots are expected on a fresh checkout.
    }
  }

  return snapshots;
}

async function loadPreviewManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, "utf8");
    const jsonText = raw
      .replace(/^\s*window\.KAZAN_EVENT_RADAR_EVENT_PREVIEWS\s*=\s*/u, "")
      .replace(/;\s*$/u, "");
    return JSON.parse(jsonText);
  } catch {
    return {};
  }
}

async function loadGeneratedPreviewFiles() {
  try {
    const entries = await fs.readdir(GENERATED_PREVIEW_DIR, { withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    );
  } catch {
    return new Set();
  }
}

function normalizeEventItem(raw) {
  const eventDate = raw?.eventDate ? new Date(raw.eventDate) : null;
  if (!eventDate || Number.isNaN(eventDate.getTime())) return null;

  const title = normalizeText(raw?.title || raw?.summary || "");
  const venueTitle = normalizeText(raw?.venueTitle || "");
  const summary = normalizeText(raw?.summary || raw?.rawSummary || raw?.shortSummary || raw?.subtitle || "");
  const rawSummary = normalizeText(raw?.rawSummary || "");
  const kind = resolvePreviewKind(raw);
  const item = {
    id: String(raw?.id || ""),
    sourceId: normalizeText(raw?.sourceId || ""),
    sourceFile: raw?.sourceFile || "",
    title,
    venueTitle,
    summary,
    rawSummary,
    kind,
    url: normalizeText(raw?.url || ""),
    imageUrl: normalizeText(raw?.imageUrl || ""),
    externalPreviewUrl: normalizeText(raw?.externalPreviewUrl || ""),
    eventDate,
    eventHasExplicitTime: Boolean(raw?.eventHasExplicitTime)
  };

  item.previewKey = buildEventPreviewKey(item);
  item.duplicateKey = buildDuplicateKey(item);
  item.descriptionDuplicateKey = buildDescriptionDuplicateKey(item);
  item.quality = buildQualityFlags(item);
  return item;
}

function buildQualityFlags(item) {
  const haystack = normalizeSearchText(`${item.title} ${item.summary} ${item.venueTitle}`);
  const readableSummary = buildReadableAuditSummary(item);
  return {
    weakTitle: item.title.length < 2 || item.title.length > 120,
    weakSummary: readableSummary.length < 45,
    missingVenue: !item.venueTitle,
    missingUrl: !item.url,
    likelyMojibake: isLikelyMojibake(`${item.title} ${item.summary} ${item.rawSummary} ${item.venueTitle}`),
    blockedLanguage: /[ӘәӨөҮүҢңҖҗҺһ]/u.test(`${item.title} ${item.summary} ${item.rawSummary} ${item.venueTitle}`),
    blockedKeyword: EXCLUDED_KEYWORDS.find((keyword) => haystack.includes(normalizeSearchText(keyword))) || ""
  };
}

function buildReadableAuditSummary(item) {
  const sourceSummary = normalizeText(item.summary || "");
  if (sourceSummary.length >= 45) return sourceSummary;

  const kindLabel = {
    concert: "Концерт",
    theatre: "Спектакль",
    show: "Шоу",
    festival: "Фестиваль",
    standup: "Стендап",
    sport: "Спортивное событие",
    exhibition: "Выставка",
    excursion: "Экскурсия",
    musical: "Мюзикл",
    kids: "Семейная программа"
  }[item.kind] || "Событие";
  const title = buildShortEventTitle(item.title || "событие");
  const dateLabel = formatDayMonth(item.eventDate);
  const place = item.venueTitle ? ` на площадке ${item.venueTitle}` : "";
  const date = dateLabel ? ` ${dateLabel}` : "";

  return `${kindLabel} «${title}» пройдёт${date}${place}. Подойдёт как понятный вариант выхода в Казани, а детали лучше проверить у источника.`;
}

function buildDuplicateGroups(items, keyProperty = "duplicateKey") {
  const groups = new Map();

  for (const item of items) {
    const key = item[keyProperty];
    if (!key) continue;
    const current = groups.get(key) || [];
    current.push(item);
    groups.set(key, current);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      key: group[0][keyProperty],
      keyProperty,
      count: group.length,
      title: group[0].title,
      venueTitle: group[0].venueTitle,
      eventDate: group[0].eventDate.toISOString(),
      sources: unique(group.map((item) => item.sourceFile || item.sourceId).filter(Boolean)),
      urls: unique(group.map((item) => item.url).filter(Boolean)).slice(0, 6)
    }))
    .sort((left, right) => right.count - left.count || left.eventDate.localeCompare(right.eventDate));
}

function dedupeAuditEventItems(items) {
  const grouped = new Map();
  const keyAliases = new Map();

  for (const item of items || []) {
    const keys = buildAuditDuplicateKeys(item);
    if (!keys.length) {
      grouped.set(`id:${item?.id || grouped.size}`, item);
      continue;
    }

    const matchedKey = keys
      .map((key) => keyAliases.get(key) || key)
      .find((key) => grouped.has(key));
    const canonicalKey = matchedKey || keys[0];
    const current = grouped.get(canonicalKey);
    grouped.set(canonicalKey, current ? mergeAuditEventItem(current, item) : item);

    for (const key of keys) {
      keyAliases.set(key, canonicalKey);
    }
  }

  return [...grouped.values()].sort((left, right) => left.eventDate - right.eventDate);
}

function buildAuditDuplicateKeys(item) {
  return [
    item.duplicateKey || buildDisplayDuplicateKey(item),
    item.descriptionDuplicateKey
  ].filter(Boolean);
}

function buildDisplayDuplicateKey(item) {
  return [
    formatMinuteKey(item.eventDate),
    normalizeEntity(item.title),
    normalizeEntity(item.venueTitle)
  ].join("|");
}

function mergeAuditEventItem(current, candidate) {
  const primary = auditEventQuality(candidate) > auditEventQuality(current) ? candidate : current;
  const secondary = primary === candidate ? current : candidate;

  return {
    ...secondary,
    ...primary,
    id: current.id || candidate.id || primary.id,
    title: pickAuditText(primary.title, secondary.title),
    summary: pickAuditText(primary.summary, secondary.summary, { preferLonger: true }),
    venueTitle: pickAuditText(primary.venueTitle, secondary.venueTitle),
    imageUrl: primary.imageUrl || secondary.imageUrl || "",
    url: primary.url || secondary.url || "",
    sourceFile: unique([current.sourceFile, candidate.sourceFile].filter(Boolean)).join(" + "),
    sourceId: unique([current.sourceId, candidate.sourceId].filter(Boolean)).join(" + ")
  };
}

function auditEventQuality(item) {
  return [
    item.imageUrl ? 40 : 0,
    item.venueTitle ? 20 : 0,
    item.eventHasExplicitTime ? 16 : 0,
    Math.min(220, String(item.summary || "").length)
  ].reduce((sum, value) => sum + value, 0);
}

function pickAuditText(preferred, fallback, options = {}) {
  const preferredText = normalizeText(preferred);
  const fallbackText = normalizeText(fallback);
  if (!preferredText) return fallbackText;
  if (!fallbackText) return preferredText;
  if (!options.preferLonger) return preferredText;
  return preferredText.length >= fallbackText.length ? preferredText : fallbackText;
}

function buildPreviewIssues(items, manifest, generatedFiles) {
  const manifestTitleIndex = buildManifestTitleIndex(manifest);
  const missing = [];
  const brandedSourceImages = [];
  const noCleanSourceImages = [];
  const generatedFallbackPreviews = [];
  let manifestHits = 0;
  let manifestTitleHits = 0;
  let fileHits = 0;
  let customBackgrounds = 0;
  let sourceBackgrounds = 0;

  for (const item of items) {
    if (!item.previewKey) continue;
    const fileName = `${item.previewKey}.jpg`;
    const manifestEntry = manifest[item.previewKey];
    const fallbackEntry = manifestEntry ? null : manifestTitleIndex.get(buildManifestTitleIndexKey(item));
    const hasFile = generatedFiles.has(fileName);
    const fallbackFileName = normalizeManifestFileName(fallbackEntry?.url || "");
    const hasFallbackFile = fallbackFileName ? generatedFiles.has(fallbackFileName) : false;

    if (manifestEntry) {
      manifestHits += 1;
    } else if (fallbackEntry) {
      manifestTitleHits += 1;
    }
    if (hasFile || hasFallbackFile) fileHits += 1;
    if ((manifestEntry || fallbackEntry)?.customBackground) customBackgrounds += 1;
    if ((manifestEntry || fallbackEntry)?.sourceBackground) sourceBackgrounds += 1;

    const imageCandidates = getImageCandidates(item);
    const brandedCandidates = imageCandidates.filter((url) => isBrandedImageUrl(url));
    const hasCleanSourceImage = imageCandidates.some((url) => isCleanExternalImageUrl(url));
    const resolvedEntry = manifestEntry || fallbackEntry;

    if (brandedCandidates.length) {
      brandedSourceImages.push(toIssue(item, {
        imageUrl: brandedCandidates[0],
        previewKey: item.previewKey
      }));
    }

    if (!hasCleanSourceImage) {
      noCleanSourceImages.push(toIssue(item, {
        previewKey: item.previewKey
      }));
    }

    if (resolvedEntry && !resolvedEntry.customBackground && !resolvedEntry.sourceBackground) {
      generatedFallbackPreviews.push(toIssue(item, {
        previewKey: item.previewKey,
        previewUrl: resolvedEntry.url || ""
      }));
    }

    if (!manifestEntry && !hasFile && !fallbackEntry && !hasFallbackFile) {
      missing.push(toIssue(item, { previewKey: item.previewKey }));
    }
  }

  return {
    manifestEntries: Object.keys(manifest).length,
    generatedFiles: generatedFiles.size,
    manifestHits,
    manifestTitleHits,
    fileHits,
    customBackgrounds,
    sourceBackgrounds,
    brandedSourceImages,
    noCleanSourceImages,
    generatedFallbackPreviews,
    missing
  };
}

function getImageCandidates(item) {
  return [...new Set([
    item?.externalPreviewUrl,
    item?.imageUrl
  ]
    .map((value) => normalizeText(value))
    .filter((value) => /^https?:\/\//i.test(value)))];
}

function isCleanExternalImageUrl(value) {
  const url = normalizeText(value);
  if (!/^https?:\/\//i.test(url)) return false;
  return !isBrandedImageUrl(url);
}

function isBrandedImageUrl(value) {
  const normalized = safeDecodeURIComponent(value).toLowerCase();
  const blockedMarkers = [
    "wmark",
    "watermark",
    "tickets",
    "ticket",
    "logo",
    "banner",
    "poster",
    "announce",
    "1200x628_wmark",
    "generated/events",
    "/brand/"
  ];

  return blockedMarkers.some((marker) => normalized.includes(marker));
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return String(value || "");
  }
}

function buildManifestTitleIndex(manifest) {
  const index = new Map();

  for (const [key, entry] of Object.entries(manifest || {})) {
    const dateKey = String(key || "").slice(0, 10);
    const titleKey = normalizeSearchText(entry?.title || "");
    if (!dateKey || !titleKey) continue;
    index.set(`${dateKey}|${titleKey}`, entry);
  }

  return index;
}

function buildManifestTitleIndexKey(item) {
  return `${formatDateKey(item.eventDate)}|${normalizeSearchText(buildShortEventTitle(item.title || item.summary))}`;
}

function normalizeManifestFileName(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return normalized.split("/").pop() || "";
}

function buildTextIssues(items) {
  const weakText = [];
  const blockedKeyword = [];
  const likelyMojibake = [];

  for (const item of items) {
    if (item.quality.blockedKeyword) {
      blockedKeyword.push(toIssue(item, { keyword: item.quality.blockedKeyword }));
    }
    if (item.quality.likelyMojibake) {
      likelyMojibake.push(toIssue(item));
    }
    if (item.quality.weakTitle || item.quality.weakSummary || item.quality.missingVenue || item.quality.missingUrl) {
      weakText.push(toIssue(item, {
        weakTitle: item.quality.weakTitle,
        weakSummary: item.quality.weakSummary,
        missingVenue: item.quality.missingVenue,
        missingUrl: item.quality.missingUrl
      }));
    }
  }

  return {
    weakText,
    blockedKeyword,
    likelyMojibake
  };
}

function buildChannelReadiness(items) {
  const sorted = [...items].sort((left, right) => left.eventDate - right.eventDate);
  const kinds = countBy(sorted, (item) => item.kind || "events");
  const next7Days = countInDays(sorted, 7);
  const next30Days = countInDays(sorted, 30);
  const next120Days = countInDays(sorted, 120);
  const dailyDraftPreviewSample = buildUniqueDraftPreviewSample(sorted, 10);
  const duplicateDraftPreviewGroups = buildDraftPreviewDuplicateGroups(sorted);

  return {
    ready: sorted.length >= 10 && next30Days >= 10 && dailyDraftPreviewSample.length >= 10,
    eligibleTotal: sorted.length,
    next7Days,
    next30Days,
    next120Days,
    uniqueKinds: Object.keys(kinds).length,
    byKind: kinds,
    uniquePreviewDraftsAvailable: dailyDraftPreviewSample.length,
    duplicateDraftPreviewGroups: duplicateDraftPreviewGroups.slice(0, cliOptions.maxDetails),
    sample: dailyDraftPreviewSample.map((item) => toIssue(item, {
      previewKey: item.previewKey,
      draftPhotoKey: buildDraftPhotoIdentity(item)
    }))
  };
}

function buildUniqueDraftPreviewSample(items, limit) {
  const selected = [];
  const selectedPhotoKeys = new Set();

  for (const item of items) {
    const photoKey = buildDraftPhotoIdentity(item);
    if (!photoKey || selectedPhotoKeys.has(photoKey)) continue;
    selected.push(item);
    selectedPhotoKeys.add(photoKey);
    if (selected.length >= limit) break;
  }

  return selected;
}

function buildDraftPreviewDuplicateGroups(items) {
  const groups = new Map();

  for (const item of items) {
    const photoKey = buildDraftPhotoIdentity(item);
    if (!photoKey) continue;
    const current = groups.get(photoKey) || [];
    current.push(item);
    groups.set(photoKey, current);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      key: buildDraftPhotoIdentity(group[0]),
      count: group.length,
      title: group[0].title,
      venueTitle: group[0].venueTitle,
      dates: group.map((item) => item.eventDate.toISOString()).slice(0, 8),
      urls: unique(group.map((item) => item.url).filter(Boolean)).slice(0, 6)
    }))
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title, "ru"));
}

function buildDraftPhotoIdentity(item) {
  const visualKey = [
    normalizeEntity(item.title || item.summary || ""),
    normalizeEntity(item.venueTitle || ""),
    normalizeEntity(item.kind || "event")
  ].filter(Boolean).join("|");

  if (visualKey) return `event-visual:${visualKey}`;
  if (item.previewKey) return `preview:${item.previewKey}`;
  if (item.imageUrl) return `source-image:${item.imageUrl}`;
  return item.id ? `item:${item.id}` : "";
}

function countInDays(items, days) {
  const from = startOfMoscowDay(new Date());
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  return items.filter((item) => item.eventDate >= from && item.eventDate < to).length;
}

function toIssue(item, extra = {}) {
  return {
    id: item.id,
    title: item.title,
    venueTitle: item.venueTitle,
    kind: item.kind,
    eventDate: item.eventDate.toISOString(),
    source: item.sourceFile || item.sourceId,
    url: item.url,
    ...extra
  };
}

function buildDuplicateKey(item) {
  return [
    formatMinuteKey(item.eventDate),
    normalizeEntity(item.title),
    normalizeEntity(item.venueTitle)
  ].join("|");
}

function buildDescriptionDuplicateKey(item) {
  const summaryKey = buildSummaryKey(`${item.rawSummary || ""} ${item.summary || ""}`);
  if (!summaryKey) return "";

  return [
    formatMinuteKey(item.eventDate),
    normalizeEntity(item.title),
    normalizeEntity(item.venueTitle),
    summaryKey
  ].join("|");
}

function buildEventPreviewKey(item) {
  const dateKey = formatDateKey(item.eventDate);
  const titleKey = normalizePreviewEntity(item.title || item.summary || "");
  const venueKey = normalizePreviewVenue(item.venueTitle || "");
  const kindKey = normalizePreviewEntity(item.kind || "event");
  const base = [dateKey, titleKey, venueKey, kindKey].filter(Boolean).join("|");
  if (!base) return "";
  return `${dateKey || "undated"}-${hashPreviewKey(base)}`;
}

function hashPreviewKey(value) {
  let hash = 2166136261;

  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizePreviewEntity(value) {
  return normalizeSearchText(value)
    .replace(/\b(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер класс|матч|турнир|билеты|казань|афиша)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePreviewVenue(value) {
  return normalizeSearchText(value)
    .replace(/\b(г казань|казань|лдс|мвц|крк|дк|кск|арена|концерт холл|пространство|площадка|сцена)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEntity(value) {
  return normalizeSearchText(value)
    .replace(/\b(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер класс|матч|билеты|казань|афиша)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSummaryKey(value) {
  return normalizeSearchText(value)
    .split(/\s+/u)
    .filter((token) => token.length >= 4)
    .slice(0, 12)
    .sort()
    .join("-");
}

function normalizeKind(value) {
  const normalized = normalizeSearchText(Array.isArray(value) ? value.join(" ") : value);
  if (normalized.includes("sport")) return "sport";
  if (normalized.includes("standup")) return "standup";
  if (normalized.includes("theatre") || normalized.includes("theater")) return "theatre";
  if (normalized.includes("show")) return "show";
  if (normalized.includes("excursion")) return "excursion";
  if (normalized.includes("festival")) return "festival";
  if (normalized.includes("musical")) return "musical";
  if (normalized.includes("exhibition")) return "exhibition";
  if (normalized.includes("kids") || normalized.includes("children")) return "kids";
  if (normalized.includes("concert")) return "concert";
  return normalized || "events";
}

function resolvePreviewKind(rawItem) {
  const normalizedKind = normalizeKind(rawItem?.kind || "");
  if (normalizedKind && normalizedKind !== "events" && normalizedKind !== "event") {
    return normalizedKind;
  }

  const text = normalizeSearchText(`${rawItem?.title || ""} ${rawItem?.summary || ""} ${rawItem?.shortSummary || ""}`);
  if (/\b(матч|хоккей|футбол|волейбол|баскетбол)\b/u.test(text)) return "sport";
  if (/\b(стендап|standup)\b/u.test(text)) return "standup";
  if (/\b(спектакл|театр|постановк)\b/u.test(text)) return "theatre";
  if (/\b(выстав|экспозици)\b/u.test(text)) return "exhibition";
  if (/\b(экскурс|тур)\b/u.test(text)) return "excursion";
  if (/\b(мюзикл)\b/u.test(text)) return "musical";
  if (/\b(фестив)\b/u.test(text)) return "festival";
  if (/\b(шоу)\b/u.test(text)) return "show";
  if (/\b(дет|семейн)\b/u.test(text)) return "kids";
  return normalizeKind(rawItem?.section || rawItem?.categories?.[1] || "concert");
}

function buildShortEventTitle(value) {
  return trimText(
    normalizeText(String(value || ""))
      .replace(/^билеты на\s+/iu, "")
      .replace(/\s+—\s+яндекс.*$/iu, "")
      .replace(/\s+на Яндекс Афише.*$/iu, "")
      .replace(/\s+на МТС Live.*$/iu, "")
      .replace(/^\d{1,2}[.:]\d{2}\s*/u, "")
      .replace(/^\d{1,2}\s+[а-яё]+\s*/iu, "")
      .replace(/^(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер-?класс)\s+/iu, "")
      .trim(),
    88
  ) || "Событие в Казани";
}

function trimText(value, maxLength) {
  const normalized = normalizeText(value);
  if (!maxLength || normalized.length <= maxLength) return normalized;
  const slice = normalized.slice(0, Math.max(0, maxLength - 1)).trim();
  const sentenceEnd = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (sentenceEnd >= Math.floor(maxLength * 0.45)) return slice.slice(0, sentenceEnd + 1).trim();

  const wordBoundary = slice.lastIndexOf(" ");
  const compact = (wordBoundary >= Math.floor(maxLength * 0.45) ? slice.slice(0, wordBoundary) : slice).trim();
  return /[.!?]$/u.test(compact) ? compact : `${compact}.`;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/ё/g, "е")
    .replace(/[«»"'`]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyMojibake(value) {
  const text = String(value || "");
  if (!text) return false;
  const suspicious = text.match(/(?:вЂ|В«|В»|Р[°±²³´µ¶·¸¹º»¼½¾¿]|С[€Ѓ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ])/gu) || [];
  return suspicious.length >= 3 || suspicious.join("").length / Math.max(1, text.length) > 0.04;
}

function formatDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function formatMinuteKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

function formatDayMonth(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long"
  }).format(date);
}

function startOfMoscowDay(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return new Date(Date.UTC(year, month - 1, day, -3, 0, 0));
}

function endOfMoscowYear(value) {
  const year = Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric"
  }).format(value));
  return new Date(Date.UTC(year + 1, 0, 1, -3, 0, 0) - 1);
}

function parseDateBoundary(value, endOfDay) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = endOfDay ? 20 : -3;
  const minute = endOfDay ? 59 : 0;
  const second = endOfDay ? 59 : 0;
  const ms = endOfDay ? 999 : 0;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
}

function countBy(items, getKey) {
  return Object.fromEntries(
    [...items.reduce((map, item) => {
      const key = String(getKey(item) || "unknown");
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map())].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ru"))
  );
}

function unique(values) {
  return [...new Set(values)];
}

function parseCliOptions(args) {
  const options = {
    from: "",
    to: "",
    strict: false,
    maxDetails: 40
  };

  for (const arg of args) {
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }

    if (arg.startsWith("--from=")) {
      options.from = arg.slice("--from=".length);
      continue;
    }

    if (arg.startsWith("--to=")) {
      options.to = arg.slice("--to=".length);
      continue;
    }

    if (arg.startsWith("--max-details=")) {
      options.maxDetails = Math.max(1, Number(arg.slice("--max-details=".length)) || options.maxDetails);
    }
  }

  return options;
}

function printSummary(report) {
  console.log("Event content audit");
  console.log(`Window: ${report.window.from} - ${report.window.to}`);
  console.log(`Future events: ${report.totals.futureItems}`);
  console.log(`Eligible events: ${report.totals.eligibleItems}`);
  console.log(`Duplicate groups: ${report.totals.duplicateGroups}`);
  console.log(`Description duplicate groups: ${report.totals.descriptionDuplicateGroups}`);
  console.log(`Missing previews: ${report.totals.missingPreviews}`);
  console.log(`Branded source images: ${report.totals.brandedSourceImages}`);
  console.log(`No clean source images: ${report.totals.noCleanSourceImages}`);
  console.log(`Generated fallback previews: ${report.totals.generatedFallbackPreviews}`);
  console.log(`Weak text items: ${report.totals.weakTextItems}`);
  console.log(`Blocked keyword items: ${report.totals.blockedKeywordItems}`);
  console.log(`Likely mojibake items: ${report.totals.likelyMojibakeItems}`);
  console.log(`Unique preview drafts available: ${report.channelReadiness.uniquePreviewDraftsAvailable}`);
  console.log(`Channel ready: ${report.channelReadiness.ready ? "yes" : "no"}`);
  console.log(`Report: ${path.relative(ROOT, REPORT_PATH)}`);
}
