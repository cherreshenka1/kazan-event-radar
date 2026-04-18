import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sourceConfig from "../config/sources.json" with { type: "json" };
import { mergeImportedPayloadToKv } from "./lib/import-payload-to-kv.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "data", "playwright", "mts-live-events.json");
const STATE_PATH = path.join(ROOT, "data", "playwright", "mts-live-state.json");
const STATE_RETENTION_DAYS = 180;

const cliOptions = parseCliOptions(process.argv.slice(2));
const MTS_SOURCES = (sourceConfig.sources || [])
  .filter((source) => source.enabled && source.type === "mts_live_collection");

process.stdout.on("error", handleBrokenPipe);
process.stderr.on("error", handleBrokenPipe);

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });

  const activeSources = MTS_SOURCES
    .filter((source) => cliOptions.sourceIds.length === 0 || cliOptions.sourceIds.includes(source.id))
    .slice(0, cliOptions.maxSources || MTS_SOURCES.length);

  if (!activeSources.length) {
    throw new Error("No enabled MTS Live sources matched the current filters.");
  }

  const syncState = await loadSyncState();
  const runStartedAt = new Date().toISOString();
  const importMode = resolveImportMode(cliOptions);
  const runMode = resolveRunMode(cliOptions);
  const collected = [];
  const stats = [];

  for (const source of activeSources) {
    log(`Collecting source: ${source.id}`);
    const links = await collectSourceLinks(source, cliOptions.maxLinksPerSource);
    const sourceState = getSourceStateBucket(syncState, source);
    markLinksDiscovered(sourceState, links, runStartedAt);

    const queuedLinks = pickLinksForCollection(links, sourceState, cliOptions);
    log(`Found links: ${links.length}`);
    log(`Queued links: ${queuedLinks.length}${cliOptions.incremental ? " (new only)" : ""}`);

    let importedForSource = 0;
    for (const [index, link] of queuedLinks.entries()) {
      log(`  [${index + 1}/${queuedLinks.length}] ${link}`);
      const html = await fetchText(link, { referer: source.url });
      const item = parseMtsAnnouncementPage(html, link, source);
      if (!item?.title) continue;
      if (!shouldKeepMtsImportedItem(item)) {
        markLinkSkipped(sourceState, item, runStartedAt);
        continue;
      }
      importedForSource += 1;
      collected.push(item);
      markLinkCollected(sourceState, item, runStartedAt);
    }

    stats.push({
      id: source.id,
      name: source.name,
      collectedLinks: links.length,
      queuedLinks: queuedLinks.length,
      skippedKnownLinks: Math.max(0, links.length - queuedLinks.length),
      importedItems: importedForSource
    });
  }

  const deduped = dedupeImportedEvents(collected);
  const payload = {
    source: "mts_browser",
    mode: importMode,
    runMode,
    syncedAt: new Date().toISOString(),
    sourceStats: stats,
    reportedImportedCount: deduped.length,
    items: deduped
  };

  await writeOutputSnapshot(OUTPUT_PATH, payload, log, "MTS Live events");
  log(`Output: ${OUTPUT_PATH}`);

  let uploadResult = null;
  if (!cliOptions.noUpload) {
    if (deduped.length) {
      uploadResult = await mergeImportedPayloadToKv(payload, {
        log
      });
      markEventsUploaded(syncState, collected, new Date().toISOString());
      log(`Uploaded MTS Live events: ${uploadResult.imported || 0}`);
    } else {
      log("Skip upload: no prepared events for this run.");
    }
  } else {
    log("Skip upload: --no-upload");
  }

  reconcileUploadedLinks(syncState);
  finalizeSyncState(syncState, {
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    runMode,
    importMode,
    noUpload: cliOptions.noUpload,
    sourceStats: stats,
    collectedItems: collected.length,
    dedupedItems: deduped.length,
    uploadedItems: uploadResult?.imported || 0,
    outputPath: path.relative(ROOT, OUTPUT_PATH)
  });

  pruneSyncState(syncState, new Date());
  await saveSyncState(syncState);
  log(`State: ${STATE_PATH}`);
}

async function collectSourceLinks(source, overrideLimit = null) {
  const links = [];
  const totalPages = Math.max(1, Number(source.pages || 1));

  for (let page = 1; page <= totalPages; page += 1) {
    const pageUrl = page === 1 ? source.url : `${source.url}?page=${page}`;
    const html = await fetchText(pageUrl, { referer: "https://live.mts.ru/kazan" });
    links.push(...extractMtsAnnouncementLinks(html));
  }

  const uniqueLinks = uniqueStrings(links).map(canonicalEventUrl).filter(Boolean);
  const requestedLimit = overrideLimit == null ? Number(source.limit || 20) : Number(overrideLimit);
  const unlimited = !requestedLimit || requestedLimit < 0;
  return unlimited ? uniqueLinks : uniqueLinks.slice(0, requestedLimit);
}

async function fetchText(url, options = {}, retries = 4) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
          ...(options.referer ? { referer: options.referer } : {})
        },
        signal: AbortSignal.timeout(45000)
      });

      if (response.ok) {
        return response.text();
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Request failed for ${url}: HTTP ${response.status}`);
        if (attempt < retries) {
          await sleep(1000 * attempt);
          continue;
        }
      }

      throw new Error(`Request failed for ${url}: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(1000 * attempt);
    }
  }

  throw lastError || new Error(`Request failed for ${url}`);
}

function extractMtsAnnouncementLinks(html) {
  return [...new Set(
    [...String(html || "").matchAll(/href=["']((?:https?:\/\/live\.mts\.ru)?\/kazan\/announcements\/[^"'#\s]+(?:\?[^"'#\s]*)?)["']/gi)]
      .map((match) => decodeHtml(match[1]))
      .map((link) => link.replace(/#.*$/i, ""))
      .map((link) => toAbsoluteUrl("https://live.mts.ru", link))
  )];
}

function parseMtsAnnouncementPage(html, url, source) {
  const data = extractNextDataJson(html);
  const details = data?.props?.pageProps?.initialState?.Announcements?.announcementDetails;
  if (!details?.title) return null;

  const eventDateValue = pickFirstValidEventDate(details.eventClosestDateTime, details.lastEventDateTime);
  const cleanSummary = cleanEventSummary(stripHtml(details.description || details.shortDescription || details.title || ""));
  const imageUrl = resolveMtsImageUrl(details, html);
  const resolvedSection = normalizeEventKind(details?.category?.alias || source.section || "events");

  return {
    sourceId: source.id,
    sourceName: source.name,
    title: buildShortEventTitle(details.title),
    subtitle: normalizeText(details.shortDescription || ""),
    summary: cleanSummary,
    shortSummary: buildShortSummary(cleanSummary),
    imageUrl: imageUrl ? toAbsoluteUrl(url, imageUrl) : "",
    venueTitle: normalizeText(details.venue?.title || ""),
    venueUrl: "",
    sourceLabel: "live.mts.ru",
    section: resolvedSection,
    url: canonicalEventUrl(url),
    eventDate: toMoscowIsoFromLocalString(eventDateValue),
    eventHasExplicitTime: Boolean(eventDateValue),
    dateText: formatSourceDateText(eventDateValue)
  };
}

function extractNextDataJson(html) {
  const raw = match(html, /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveMtsImageUrl(details, html = "") {
  const mediaItems = Array.isArray(details?.media) ? details.media : [];
  const mediaPoster = mediaItems.find((item) => /poster/i.test(String(item?.type || "")))?.url || "";
  const mediaGallery = mediaItems.find((item) => /gallery/i.test(String(item?.type || "")))?.url || "";

  return [
    details?.poster?.url,
    details?.posterUrl,
    details?.banner?.url,
    details?.banner?.src,
    mediaPoster,
    mediaGallery,
    extractMetaContent(html, "og:image"),
    extractMetaContent(html, "twitter:image")
  ].find((value) => normalizeText(value)) || "";
}

function extractMetaContent(html, name) {
  return normalizeText(
    decodeHtml(
      match(html, new RegExp(`<meta[^>]+property=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"))
      || match(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegExp(name)}["']`, "i"))
      || match(html, new RegExp(`<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"))
      || match(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRegExp(name)}["']`, "i"))
      || ""
    )
  );
}

function buildShortEventTitle(value) {
  return trim(
    normalizeText(String(value || ""))
      .replace(/^Купить билеты на\s+/iu, "")
      .replace(/^Билеты на\s+/iu, "")
      .replace(/^Билеты в\s+/iu, "")
      .replace(/^(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер-?класс)\s+/iu, "")
      .replace(/\s+—\s+Яндекс.*$/iu, "")
      .replace(/\s+на Яндекс Афише.*$/iu, "")
      .replace(/\s+на MTS Live.*$/iu, ""),
    120
  );
}

function buildShortSummary(value) {
  const text = normalizeText(value);
  if (!text) return "";

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!sentences.length) {
    return trim(text, 220);
  }

  return trim(sentences.slice(0, 2).join(" "), 220);
}

function shouldKeepMtsImportedItem(item) {
  return isFutureEventDate(item?.eventDate) && !looksOutsideKazan(item);
}

function isFutureEventDate(isoValue) {
  if (!isoValue) return false;
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return false;
  return date >= getStartOfTodayInMoscow();
}

function getStartOfTodayInMoscow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = (type) => Number(parts.find((item) => item.type === type)?.value || 0);
  return new Date(Date.UTC(value("year"), value("month") - 1, value("day"), -3, 0, 0));
}

function looksOutsideKazan(item) {
  const haystack = normalizeText([
    item?.title,
    item?.venueTitle,
    item?.url
  ].filter(Boolean).join(" ")).toLowerCase();

  if (!haystack) return false;

  const outsidePatterns = [
    /chistopol/i,
    /zelenodolsk/i,
    /almet/i,
    /nizhnekamsk/i,
    /naberezhn/i,
    /elabug/i,
    /bugulm/i,
    /leninogorsk/i,
    /buinsk/i,
    /yoshkar/i,
    /ulyanovsk/i,
    /чистопол/iu,
    /зеленодоль/iu,
    /альмет/iu,
    /нижнекам/iu,
    /набережн/iu,
    /елабуг/iu,
    /бугульм/iu,
    /лениногор/iu,
    /буинск/iu,
    /йошкар/iu,
    /ульяновск/iu
  ];

  return outsidePatterns.some((pattern) => pattern.test(haystack));
}

function cleanEventSummary(value) {
  return trim(normalizeText(String(value || "")), 560);
}

function stripHtml(value) {
  return normalizeText(
    decodeHtml(String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "))
  );
}

function normalizeEventKind(section) {
  return {
    concert: "concert",
    concerts: "concert",
    theatre: "theatre",
    theater: "theatre",
    theatre_show: "theatre",
    spectacle: "theatre",
    monoperformance: "theatre",
    show: "show",
    festival: "show",
    circus_show: "show",
    show_and_musicals: "show",
    standup: "standup",
    exhibition: "exhibition",
    exhibitions: "exhibition",
    art: "exhibition",
    excursion: "excursion",
    excursions: "excursion",
    musical: "musical",
    musicals: "musical",
    sport: "sport",
    sports: "sport",
    kids: "kids",
    children: "kids"
  }[section] || "events";
}

function pickFirstValidEventDate(...values) {
  return values.find((value) => isValidEventDateValue(value)) || null;
}

function isValidEventDateValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  if (/^0001-01-01T00:00:00(?:\.000)?$/i.test(normalized)) return false;
  return !Number.isNaN(new Date(
    /Z$/i.test(normalized) || /[+-]\d{2}:\d{2}$/i.test(normalized)
      ? normalized
      : `${normalized}+03:00`
  ).getTime());
}

function toMoscowIsoFromLocalString(value) {
  if (!value || !isValidEventDateValue(value)) return null;
  if (/Z$/i.test(value) || /[+-]\d{2}:\d{2}$/i.test(value)) return new Date(value).toISOString();
  return new Date(`${value}+03:00`).toISOString();
}

function formatSourceDateText(value) {
  if (!value || !isValidEventDateValue(value)) return "";

  const date = new Date(
    /Z$/i.test(value) || /[+-]\d{2}:\d{2}$/i.test(value)
      ? value
      : `${value}+03:00`
  );

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

async function loadSyncState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return normalizeSyncState(JSON.parse(raw));
  } catch {
    return createEmptySyncState();
  }
}

async function saveSyncState(state) {
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writeOutputSnapshot(filePath, payload, log, label) {
  if ((payload?.items || []).length > 0 || !await fileExists(filePath)) {
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    log(`Saved ${label}: ${(payload?.items || []).length}`);
    return;
  }

  log(`Keep previous ${label}: current run returned 0 items.`);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createEmptySyncState() {
  return {
    source: "mts_browser_state",
    updatedAt: null,
    lastRun: null,
    sources: {}
  };
}

function normalizeSyncState(value) {
  const normalized = createEmptySyncState();
  if (!value || typeof value !== "object") return normalized;

  normalized.updatedAt = value.updatedAt || null;
  normalized.lastRun = value.lastRun || null;
  normalized.sources = {};

  for (const [sourceId, bucket] of Object.entries(value.sources || {})) {
    normalized.sources[sourceId] = {
      id: bucket?.id || sourceId,
      name: bucket?.name || sourceId,
      url: bucket?.url || "",
      updatedAt: bucket?.updatedAt || null,
      lastDiscoveredAt: bucket?.lastDiscoveredAt || null,
      links: {}
    };

    for (const [url, entry] of Object.entries(bucket?.links || {})) {
      const canonicalUrl = canonicalEventUrl(url);
      if (!canonicalUrl) continue;
      normalized.sources[sourceId].links[canonicalUrl] = {
        url: canonicalUrl,
        firstSeenAt: entry?.firstSeenAt || null,
        lastSeenAt: entry?.lastSeenAt || null,
        collectedAt: entry?.collectedAt || null,
        uploadedAt: entry?.uploadedAt || null,
        pendingUpload: Boolean(entry?.pendingUpload),
        title: entry?.title || "",
        eventDate: entry?.eventDate || null
      };
    }
  }

  return normalized;
}

function getSourceStateBucket(state, source) {
  if (!state.sources[source.id]) {
    state.sources[source.id] = {
      id: source.id,
      name: source.name,
      url: source.url,
      updatedAt: null,
      lastDiscoveredAt: null,
      links: {}
    };
  }

  const bucket = state.sources[source.id];
  bucket.name = source.name || bucket.name;
  bucket.url = source.url || bucket.url;
  return bucket;
}

function markLinksDiscovered(bucket, links, nowIso) {
  bucket.lastDiscoveredAt = nowIso;
  bucket.updatedAt = nowIso;

  for (const rawLink of links) {
    const link = canonicalEventUrl(rawLink);
    if (!link) continue;
    const current = bucket.links[link] || {
      url: link,
      firstSeenAt: nowIso,
      lastSeenAt: null,
      collectedAt: null,
      uploadedAt: null,
      pendingUpload: false,
      title: "",
      eventDate: null
    };

    current.lastSeenAt = nowIso;
    bucket.links[link] = current;
  }
}

function pickLinksForCollection(links, bucket, options) {
  if (!options.incremental) return links;

  return links.filter((rawLink) => {
    const link = canonicalEventUrl(rawLink);
    const current = bucket.links[link];
    if (!current) return true;
    return current.pendingUpload || !current.collectedAt;
  });
}

function markLinkCollected(bucket, event, nowIso) {
  const link = canonicalEventUrl(event?.url);
  if (!link) return;

  const current = bucket.links[link] || {
    url: link,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    collectedAt: null,
    uploadedAt: null,
    pendingUpload: false,
    title: "",
    eventDate: null
  };

  current.lastSeenAt = nowIso;
  current.collectedAt = nowIso;
  current.pendingUpload = true;
  current.title = event?.title || current.title || "";
  current.eventDate = event?.eventDate || current.eventDate || null;
  bucket.links[link] = current;
  bucket.updatedAt = nowIso;
}

function markLinkSkipped(bucket, event, nowIso) {
  const link = canonicalEventUrl(event?.url);
  if (!link) return;

  const current = bucket.links[link] || {
    url: link,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    collectedAt: null,
    uploadedAt: null,
    pendingUpload: false,
    title: "",
    eventDate: null
  };

  current.lastSeenAt = nowIso;
  current.collectedAt = nowIso;
  current.pendingUpload = false;
  current.title = event?.title || current.title || "";
  current.eventDate = event?.eventDate || current.eventDate || null;
  bucket.links[link] = current;
  bucket.updatedAt = nowIso;
}

function markEventsUploaded(state, events, nowIso) {
  for (const event of events) {
    const sourceId = event?.sourceId;
    const link = canonicalEventUrl(event?.url);
    if (!link) continue;

    const targetBuckets = new Set();
    const primaryBucket = sourceId ? state.sources[sourceId] : null;
    if (primaryBucket) {
      targetBuckets.add(primaryBucket);
    }

    for (const bucket of Object.values(state.sources || {})) {
      if (bucket?.links?.[link]) {
        targetBuckets.add(bucket);
      }
    }

    for (const bucket of targetBuckets) {
      const current = bucket.links[link] || {
        url: link,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        collectedAt: nowIso,
        uploadedAt: null,
        pendingUpload: true,
        title: "",
        eventDate: null
      };

      current.uploadedAt = nowIso;
      current.pendingUpload = false;
      current.title = event?.title || current.title || "";
      current.eventDate = event?.eventDate || current.eventDate || null;
      bucket.links[link] = current;
      bucket.updatedAt = nowIso;
    }
  }
}

function reconcileUploadedLinks(state) {
  const uploadedByLink = new Map();

  for (const bucket of Object.values(state.sources || {})) {
    for (const entry of Object.values(bucket?.links || {})) {
      if (!entry?.url) continue;
      if (!entry.uploadedAt && entry.pendingUpload) continue;

      const current = uploadedByLink.get(entry.url) || {
        uploadedAt: entry.uploadedAt || null,
        title: entry.title || "",
        eventDate: entry.eventDate || null
      };

      if (entry.uploadedAt && (!current.uploadedAt || entry.uploadedAt > current.uploadedAt)) {
        current.uploadedAt = entry.uploadedAt;
      }
      if (!current.title && entry.title) {
        current.title = entry.title;
      }
      if (!current.eventDate && entry.eventDate) {
        current.eventDate = entry.eventDate;
      }

      uploadedByLink.set(entry.url, current);
    }
  }

  for (const bucket of Object.values(state.sources || {})) {
    for (const entry of Object.values(bucket?.links || {})) {
      const uploaded = uploadedByLink.get(entry?.url);
      if (!uploaded?.uploadedAt) continue;
      entry.uploadedAt = uploaded.uploadedAt;
      entry.pendingUpload = false;
      entry.title = entry.title || uploaded.title || "";
      entry.eventDate = entry.eventDate || uploaded.eventDate || null;
    }
  }
}

function finalizeSyncState(state, meta) {
  state.updatedAt = meta.finishedAt;
  state.lastRun = meta;
}

function pruneSyncState(state, now = new Date()) {
  const cutoff = new Date(now.getTime() - STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  for (const bucket of Object.values(state.sources || {})) {
    for (const [link, entry] of Object.entries(bucket.links || {})) {
      const lastSeen = entry?.lastSeenAt ? new Date(entry.lastSeenAt) : null;
      const keepBecausePending = Boolean(entry?.pendingUpload);
      const keepBecauseRecent = lastSeen && !Number.isNaN(lastSeen.getTime()) && lastSeen >= cutoff;

      if (!keepBecausePending && !keepBecauseRecent) {
        delete bucket.links[link];
      }
    }
  }
}

function toAbsoluteUrl(origin, value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return new URL(value, origin).toString();
}

function canonicalEventUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw, "https://live.mts.ru");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function dedupeImportedEvents(items) {
  const grouped = new Map();

  for (const item of items || []) {
    const key = [
      normalizeText(item.title).toLowerCase(),
      item.eventDate ? item.eventDate.slice(0, 16) : "",
      normalizeText(item.venueTitle).toLowerCase()
    ].join("::");

    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, item);
      continue;
    }

    const keepCandidate = scoreImportedItem(item) > scoreImportedItem(current);
    grouped.set(key, keepCandidate ? item : current);
  }

  return [...grouped.values()];
}

function scoreImportedItem(item) {
  return [
    item.imageUrl ? 40 : 0,
    (item.summary || "").length,
    item.eventHasExplicitTime ? 20 : 0,
    (item.venueTitle || "").length
  ].reduce((sum, value) => sum + value, 0);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trim(value, maxLength) {
  const normalized = normalizeText(value);
  if (!maxLength || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function match(value, pattern) {
  return String(value || "").match(pattern)?.[1] || null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveImportMode(options) {
  return options.reconcile ? "replace_source" : "merge";
}

function resolveRunMode(options) {
  if (options.reconcile) return "reconcile";
  if (options.incremental) return "incremental";
  if (options.all) return "all";
  return "manual";
}

function parseCliOptions(args) {
  const options = {
    noUpload: false,
    quiet: false,
    all: false,
    incremental: false,
    reconcile: false,
    chunkSize: 25,
    sourceIds: [],
    maxLinksPerSource: null,
    maxSources: null
  };

  for (const arg of args) {
    if (arg === "--no-upload") {
      options.noUpload = true;
      continue;
    }

    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }

    if (arg === "--all") {
      options.all = true;
      options.maxLinksPerSource = 0;
      continue;
    }

    if (arg === "--incremental") {
      options.incremental = true;
      continue;
    }

    if (arg === "--reconcile") {
      options.reconcile = true;
      options.all = true;
      options.maxLinksPerSource = 0;
      continue;
    }

    if (arg.startsWith("--source=")) {
      options.sourceIds.push(arg.slice("--source=".length));
      continue;
    }

    if (arg.startsWith("--max-links=")) {
      options.maxLinksPerSource = Number(arg.slice("--max-links=".length)) || null;
      continue;
    }

    if (arg.startsWith("--max-sources=")) {
      options.maxSources = Number(arg.slice("--max-sources=".length)) || null;
      continue;
    }

    if (arg.startsWith("--chunk-size=")) {
      options.chunkSize = Number(arg.slice("--chunk-size=".length)) || 25;
    }
  }

  return options;
}

function log(...args) {
  if (cliOptions.quiet) return;
  console.log(...args);
}

function handleBrokenPipe(error) {
  if (error?.code === "EPIPE") {
    process.exit(0);
  }

  throw error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
