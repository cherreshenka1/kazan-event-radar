import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sourceConfig from "../config/sources.json" with { type: "json" };
import { mergeImportedPayloadToKv } from "./lib/import-payload-to-kv.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "data", "playwright", "yandex-browser-events.json");
const STATE_PATH = path.join(ROOT, "data", "playwright", "yandex-browser-state.json");
const STATE_RETENTION_DAYS = 180;
const cliOptions = parseCliOptions(process.argv.slice(2));

const YANDEX_SOURCES = (sourceConfig.sources || [])
  .filter((source) => source.enabled && source.type === "yandex_afisha_listing");

const ALLOWED_SECTIONS = [
  "concert",
  "theatre",
  "theatre_show",
  "show",
  "standup",
  "exhibition",
  "excursion",
  "excursions",
  "musical",
  "art",
  "kids",
  "circus_show",
  "festival",
  "sport",
  "other",
  "monoperformance"
];

async function main() {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });

  const authStatePath = await resolveAuthStatePath(cliOptions.authStatePath);
  const syncState = await loadSyncState();
  const runStartedAt = new Date().toISOString();
  const importMode = resolveImportMode(cliOptions);
  const runMode = resolveRunMode(cliOptions);

  const browser = await launchBrowser();
  const context = await browser.newContext({
    storageState: authStatePath,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    viewport: { width: 1440, height: 1200 }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  await page.setExtraHTTPHeaders({
    "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
  });

  try {
    const shouldUpload = !cliOptions.noUpload;
    const activeSources = YANDEX_SOURCES
      .filter((source) => cliOptions.sourceIds.length === 0 || cliOptions.sourceIds.includes(source.id))
      .slice(0, cliOptions.maxSources || YANDEX_SOURCES.length);

    if (!activeSources.length) {
      throw new Error("No enabled Yandex sources matched the current filters.");
    }

    const collected = [];
    const stats = [];

    for (const source of activeSources) {
      console.log(`Collecting source: ${source.id}`);
      const links = await collectSourceLinks(page, source, cliOptions.maxLinksPerSource);
      const sourceState = getSourceStateBucket(syncState, source);
      markLinksDiscovered(sourceState, links, runStartedAt);

      const queuedLinks = pickLinksForCollection(links, sourceState, cliOptions);
      console.log(`Found links: ${links.length}`);
      console.log(`Queued links: ${queuedLinks.length}${cliOptions.incremental ? " (new only)" : ""}`);

      let importedForSource = 0;
      for (const [index, link] of queuedLinks.entries()) {
        console.log(`  [${index + 1}/${queuedLinks.length}] ${link}`);
        const event = await collectEventDetails(page, link, source);
        if (!event?.title) continue;
        importedForSource += 1;
        collected.push(event);
        markLinkCollected(sourceState, event, runStartedAt);
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
      source: "yandex_browser",
      mode: importMode,
      runMode,
      syncedAt: new Date().toISOString(),
      sourceStats: stats,
      reportedImportedCount: deduped.length,
      items: deduped
    };

    await writeOutputSnapshot(OUTPUT_PATH, payload, console.log, "Yandex browser events");
    console.log(`Output: ${OUTPUT_PATH}`);

    let uploadResult = null;
    if (shouldUpload) {
      if (deduped.length) {
        uploadResult = await mergeImportedPayloadToKv(payload, {
          log: console.log
        });
        markEventsUploaded(syncState, collected, new Date().toISOString());
        console.log(`Uploaded Yandex browser events: ${uploadResult.imported || 0}`);
      } else {
        console.log("Skip upload: no prepared events for this run.");
      }
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
    console.log(`State: ${STATE_PATH}`);
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

async function collectSourceLinks(page, source, overrideLimit = null) {
  const requestedLimit = overrideLimit == null ? Number(source.limit || 20) : Number(overrideLimit);
  const unlimited = !requestedLimit || requestedLimit < 0;
  const limit = unlimited ? Number.POSITIVE_INFINITY : requestedLimit;

  await gotoAndSettle(page, source.url);
  await dismissYandexPopups(page);

  const links = new Set();
  let stagnantRounds = 0;

  for (let round = 0; round < 24; round += 1) {
    const batch = await page.evaluate((allowedSections) => {
      const allowed = new Set(allowedSections);

      return [...document.querySelectorAll("a[href]")]
        .map((anchor) => anchor.href || anchor.getAttribute("href") || "")
        .filter(Boolean)
        .map((href) => {
          try {
            const url = new URL(href, location.origin);
            url.search = "";
            url.hash = "";
            return url;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((url) => url.origin === location.origin)
        .filter((url) => {
          const segments = url.pathname.split("/").filter(Boolean);
          return segments[0] === "kazan" && segments.length === 3 && allowed.has(segments[1]);
        })
        .map((url) => url.toString());
    }, ALLOWED_SECTIONS);

    const before = links.size;
    for (const link of batch) {
      links.add(link);
    }

    if (links.size >= limit) break;
    stagnantRounds = links.size === before ? stagnantRounds + 1 : 0;
    if (stagnantRounds >= 3) break;

    await page.mouse.wheel(0, 2600);
    await page.waitForTimeout(1200);
  }

  return unlimited ? [...links] : [...links].slice(0, limit);
}

async function collectEventDetails(page, link, source) {
  try {
    await gotoAndSettle(page, link);
    await dismissYandexPopups(page);

    const details = await page.evaluate(() => {
      const normalize = (value) => String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const text = (node) => normalize(node?.textContent || "");
      const meta = (name, attr = "property") => normalize(document.querySelector(`meta[${attr}="${name}"]`)?.content || "");
      const findHeading = (pattern) => [...document.querySelectorAll("h1,h2,h3,h4")]
        .find((node) => pattern.test(text(node)));
      const isNoise = (value) => !value
        || value.length > 260
        || /[{};]/.test(value)
        || /^window\./i.test(value)
        || /^@media/i.test(value);
      const visibleText = [...document.querySelectorAll("body *")]
        .filter((node) => !["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH"].includes(node.tagName))
        .map((node) => text(node))
        .filter((value) => value && !isNoise(value));
      const unique = (values) => [...new Set(values.map(normalize).filter(Boolean))];
      const firstNonEmpty = (...values) => unique(values).find(Boolean) || "";
      const extractStrings = (value) => {
        const result = [];
        const push = (input) => {
          if (!input) return;
          if (Array.isArray(input)) {
            input.forEach(push);
            return;
          }
          if (typeof input === "string") {
            const normalized = normalize(input);
            if (normalized) result.push(normalized);
            return;
          }
          if (typeof input !== "object") return;
          push(input.url);
          push(input.contentUrl);
          push(input.image);
          push(input.src);
          push(input["@id"]);
        };

        push(value);
        return unique(result);
      };
      const parseJsonLdEvent = () => {
        const rawNodes = [...document.querySelectorAll('script[type="application/ld+json"]')]
          .map((node) => node.textContent || "");
        const queue = [];

        for (const raw of rawNodes) {
          try {
            queue.push(JSON.parse(raw));
          } catch {
            // ignore invalid json-ld
          }
        }

        const flat = [];
        const push = (value) => {
          if (!value) return;
          if (Array.isArray(value)) {
            value.forEach(push);
            return;
          }
          if (typeof value !== "object") return;
          flat.push(value);
          if (value["@graph"]) push(value["@graph"]);
        };

        queue.forEach(push);
        return flat.find((item) => String(item["@type"] || "").toLowerCase().includes("event")) || null;
      };

      const aboutHeading = findHeading(/о событии/i);
      const aboutChunks = [];

      if (aboutHeading) {
        let node = aboutHeading.nextElementSibling;
        while (node && !/^H[1-4]$/.test(node.tagName)) {
          const value = text(node);
          if (value) aboutChunks.push(value);
          node = node.nextElementSibling;
        }
      }

      const placeAnchor = [...document.querySelectorAll('a[href*="/places/"]')]
        .find((node) => text(node));
      const bodyText = normalize(document.body?.innerText || "");
      const h1 = document.querySelector("h1");
      const ldEvent = parseJsonLdEvent();

      const sourceHeading = [...document.querySelectorAll("body *")]
        .find((node) => /^Источник:?$/i.test(text(node)));
      const sourceFromHeading = (() => {
        if (!sourceHeading) return "";
        let node = sourceHeading.nextElementSibling;
        while (node) {
          const value = text(node);
          if (value && !isNoise(value) && !/^Источник:?$/i.test(value)) return value;
          node = node.nextElementSibling;
        }
        return "";
      })();
      const sourceLine = visibleText.find((value) => /^Источник:\s*/i.test(value)) || "";

      const focusText = (() => {
        const title = text(h1);
        const startAt = title ? Math.max(0, bodyText.indexOf(title)) : 0;
        return bodyText.slice(startAt, startAt + 2600);
      })();
      const scheduleText = (() => {
        const scheduleIndex = bodyText.indexOf("Расписание");
        if (scheduleIndex === -1) return "";
        return bodyText.slice(scheduleIndex, scheduleIndex + 900);
      })();
      const searchableDateText = unique([focusText, scheduleText]).join(" ");
      const dateCandidates = [...searchableDateText.matchAll(/(\d{1,2}(?:\s*[–-]\s*\d{1,2})?(?:\s+[а-яё]+){0,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?(?:(?:,\s*|\s+)[а-яё]+)?(?:(?:,\s*|\s+)\d{1,2}:\d{2})?)/giu)]
        .map((match) => normalize(match[1]));
      const resolvedDateText = dateCandidates.find((value) => /\d{1,2}:\d{2}/.test(value))
        || dateCandidates[0]
        || "";
      const rawSubtitle = (() => {
        let node = h1?.nextElementSibling || null;
        while (node) {
          const value = text(node);
          if (value && value !== resolvedDateText && !/^Расписание/i.test(value)) return value;
          if (/^H[1-4]$/.test(node.tagName)) break;
          node = node.nextElementSibling;
        }
        return "";
      })();
      const pathSegments = location.pathname.split("/").filter(Boolean);
      const imageCandidates = unique([
        ...extractStrings(ldEvent?.image),
        meta("og:image"),
        meta("twitter:image", "name")
      ]);

      return {
        title: firstNonEmpty(text(h1), normalize(ldEvent?.name), normalize(document.title).replace(/\s+[–-]\s+.+$/u, "")),
        subtitle: rawSubtitle,
        summary: firstNonEmpty(aboutChunks.join(" "), normalize(ldEvent?.description), meta("description", "name"), meta("description", "property")),
        imageUrl: imageCandidates[0] || "",
        dateText: resolvedDateText,
        scheduleText,
        startDate: normalize(ldEvent?.startDate),
        endDate: normalize(ldEvent?.endDate),
        venueTitle: firstNonEmpty(text(placeAnchor), normalize(ldEvent?.location?.name)),
        venueUrl: placeAnchor?.href || normalize(ldEvent?.location?.url),
        sourceLabel: sourceFromHeading || sourceLine.replace(/^Источник:\s*/i, ""),
        section: pathSegments[1] || "events",
        url: location.origin + location.pathname
      };
    });

    const eventDate = resolveYandexEventDate(details);
    const subtitle = sanitizeYandexSubtitle(details.subtitle);
    const summary = cleanYandexContentText(details.summary || subtitle || details.title);
    const shortSummary = buildCompactSummary(subtitle || summary || details.title);

    return {
      sourceId: source.id,
      sourceName: source.name,
      title: normalizeText(details.title),
      subtitle,
      summary: summary || normalizeText(details.title),
      shortSummary: shortSummary || normalizeText(details.title),
      imageUrl: details.imageUrl || "",
      venueTitle: normalizeText(details.venueTitle),
      venueUrl: details.venueUrl || "",
      sourceLabel: normalizeText(details.sourceLabel),
      section: details.section || source.section || "events",
      url: details.url || link,
      eventDate: eventDate?.iso || null,
      eventHasExplicitTime: Boolean(eventDate?.hasExplicitTime),
      dateText: details.dateText || formatRussianDateText(eventDate) || ""
    };
  } catch (error) {
    console.warn(`Skip event: ${link}`);
    console.warn(error.message);
    return null;
  }
}

async function dismissYandexPopups(page) {
  const selectors = [
    'button[aria-label="Закрыть"]',
    'button[aria-label="Close"]',
    '[data-testid="modal-close"]',
    'button:has-text("Понятно")',
    'button:has-text("Хорошо")',
    'button:has-text("Закрыть")'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;

    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    await locator.click({ timeout: 3000 }).catch(() => null);
    await page.waitForTimeout(250);
  }
}

async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(1600);
}

async function resolveAuthStatePath(overridePath = "") {
  const candidates = [
    overridePath,
    process.env.PLAYWRIGHT_AUTH_STATE_PATH,
    "data/playwright/auth-state.json",
    "data/playwright/yandex-state.json"
  ].filter(Boolean);

  for (const candidate of candidates) {
    const fullPath = path.resolve(ROOT, candidate);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // keep looking
    }
  }

  throw new Error("Saved browser auth state was not found. Put a state file into data/playwright/auth-state.json or pass --auth-state=...");
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
    source: "yandex_browser_state",
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

async function launchBrowser() {
  const executablePath = await findBrowserExecutable();
  return chromium.launch({
    headless: cliOptions.headless,
    executablePath
  });
}

async function findBrowserExecutable() {
  if (cliOptions.browserPath) {
    const fullPath = path.resolve(cliOptions.browserPath);
    await fs.access(fullPath);
    return fullPath;
  }

  const candidates = [
    process.env.PLAYWRIGHT_BROWSER_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Yandex", "YandexBrowser", "Application", "browser.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Yandex", "YandexBrowser", "Application", "browser.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }

  throw new Error("Browser executable was not found. Install Chrome/Edge or pass --browser-path=...");
}

function parseRussianEventDate(value) {
  const normalized = normalizeRussianDateInput(value);
  if (!normalized || /постоянно/i.test(normalized)) return null;

  const months = {
    "января": 0,
    "февраля": 1,
    "марта": 2,
    "апреля": 3,
    "мая": 4,
    "июня": 5,
    "июля": 6,
    "августа": 7,
    "сентября": 8,
    "октября": 9,
    "ноября": 10,
    "декабря": 11
  };

  const match = normalized.match(/(\d{1,2})(?:\s*[–-]\s*\d{1,2})?(?:\s+[а-яё]+){0,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/iu);
  if (!match) return null;

  const timeMatch = normalized.match(/(\d{1,2}):(\d{2})/);
  const now = new Date();
  const day = Number(match[1]);
  const month = months[match[2].toLowerCase()];
  const explicitYear = Number(match[3] || 0);
  const hour = Number(timeMatch?.[1] || 12);
  const minute = Number(timeMatch?.[2] || 0);
  let year = explicitYear || Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric" }).format(now));

  let iso = toMoscowIso(year, month, day, hour, minute);
  const candidate = new Date(iso);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  if (!explicitYear && candidate < twoWeeksAgo) {
    year += 1;
    iso = toMoscowIso(year, month, day, hour, minute);
  }

  return {
    iso,
    hasExplicitTime: Boolean(timeMatch?.[1] && timeMatch?.[2]),
    year,
    month,
    day,
    hour,
    minute
  };
}

function toMoscowIso(year, month, day, hour = 12, minute = 0) {
  return new Date(Date.UTC(year, month, day, hour - 3, minute, 0)).toISOString();
}

function resolveYandexEventDate(details) {
  const fromSourceText = parseRussianEventDate(details?.dateText);
  const fromScheduleText = parseRussianEventDate(details?.scheduleText);
  let resolved = fromSourceText || fromScheduleText || parseIsoLikeEventDate(details?.startDate);

  if (resolved && !resolved.hasExplicitTime) {
    resolved = enrichEventDateWithTime(resolved, details?.dateText)
      || enrichEventDateWithTime(resolved, details?.scheduleText)
      || resolved;
  }

  return resolved;
}

function parseIsoLikeEventDate(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  const dateOnlyMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]) - 1;
    const day = Number(dateOnlyMatch[3]);
    return {
      iso: toMoscowIso(year, month, day, 12, 0),
      hasExplicitTime: false,
      year,
      month,
      day,
      hour: 12,
      minute: 0
    };
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = getMoscowDateParts(parsed);
  return {
    iso: toMoscowIso(parts.year, parts.month, parts.day, parts.hour, parts.minute),
    hasExplicitTime: true,
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute
  };
}

function enrichEventDateWithTime(dateInfo, sourceText) {
  const time = extractFirstTime(sourceText);
  if (!dateInfo || !time) return null;

  return {
    ...dateInfo,
    iso: toMoscowIso(dateInfo.year, dateInfo.month, dateInfo.day, time.hour, time.minute),
    hasExplicitTime: true,
    hour: time.hour,
    minute: time.minute
  };
}

function extractFirstTime(value) {
  const normalized = normalizeText(value);
  const match = normalized.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;

  return {
    hour: Number(match[1]),
    minute: Number(match[2])
  };
}

function getMoscowDateParts(date) {
  const formattedParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const part = (type) => Number(formattedParts.find((item) => item.type === type)?.value || 0);
  return {
    year: part("year"),
    month: part("month") - 1,
    day: part("day"),
    hour: part("hour"),
    minute: part("minute")
  };
}

function normalizeRussianDateInput(value) {
  return normalizeText(value)
    .replace(/(\d)([А-Яа-яЁё])/g, "$1 $2")
    .replace(/([А-Яа-яЁё])(\d)/g, "$1 $2")
    .replace(/(сегодня|завтра|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/giu, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function formatRussianDateText(dateInfo) {
  if (!dateInfo) return "";

  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря"
  ];
  const currentYear = Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric"
  }).format(new Date()));
  const dateText = `${dateInfo.day} ${months[dateInfo.month]}${dateInfo.year !== currentYear ? ` ${dateInfo.year}` : ""}`;

  if (!dateInfo.hasExplicitTime) return dateText;
  return `${dateText}, ${String(dateInfo.hour).padStart(2, "0")}:${String(dateInfo.minute).padStart(2, "0")}`;
}

function cleanYandexContentText(value) {
  return normalizeText(String(value || "")
    .replace(/Читать полностью/giu, " ")
    .replace(/Показать ещё/giu, " ")
    .replace(/Подробнее/giu, " "));
}

function sanitizeYandexSubtitle(value) {
  const cleaned = cleanYandexContentText(value)
    .replace(/Купить билеты/giu, " ")
    .replace(/Уже ходил/giu, " ")
    .replace(/Читать отзывы/giu, " ")
    .replace(/Хочу сходить/giu, " ")
    .replace(/до\s*\d+%/giu, " ")
    .replace(/\b\d+[.,]?\d*\s*рейтинг\b/giu, " ")
    .replace(/\b\d+\s*оцен(?:ок|ки|ка)\b/giu, " ")
    .replace(/\b\d+\s*отзыв(?:ов|а)?\b/giu, " ");

  const normalized = normalizeText(cleaned);
  if (!normalized) return "";
  if (normalized.length > 160) return "";
  return normalized;
}

function buildCompactSummary(value, maxLength = 180) {
  const normalized = cleanYandexContentText(value);
  if (!normalized) return "";

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  let result = "";
  for (const sentence of sentences) {
    if (!sentence) continue;
    const next = result ? `${result} ${sentence}` : sentence;
    if (next.length > maxLength) break;
    result = next;
  }

  if (result) return result;
  return normalized.slice(0, maxLength).trim().replace(/[,:;.\-–\s]+$/u, "");
}

function dedupeImportedEvents(items) {
  const map = new Map();

  for (const item of items) {
    const key = [
      normalizeText(item.title).toLowerCase(),
      item.eventDate ? item.eventDate.slice(0, 16) : "",
      normalizeText(item.venueTitle).toLowerCase()
    ].join("::");

    if (!map.has(key)) {
      map.set(key, item);
      continue;
    }

    const current = map.get(key);
    const keepCurrent = (current.summary || "").length >= (item.summary || "").length;
    map.set(key, keepCurrent ? current : item);
  }

  return [...map.values()];
}

function canonicalEventUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw, "https://afisha.yandex.ru");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    all: false,
    incremental: false,
    reconcile: false,
    chunkSize: 8,
    pauseMs: 1200,
    retries: 6,
    sourceIds: [],
    maxLinksPerSource: null,
    maxSources: null,
    authStatePath: "",
    browserPath: "",
    headless: false
  };

  for (const arg of args) {
    if (arg === "--no-upload") {
      options.noUpload = true;
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

    if (arg === "--headless") {
      options.headless = true;
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
      options.chunkSize = Number(arg.slice("--chunk-size=".length)) || 8;
      continue;
    }

    if (arg.startsWith("--pause-ms=")) {
      options.pauseMs = Number(arg.slice("--pause-ms=".length)) || 0;
      continue;
    }

    if (arg.startsWith("--retries=")) {
      options.retries = Number(arg.slice("--retries=".length)) || 6;
      continue;
    }

    if (arg.startsWith("--auth-state=")) {
      options.authStatePath = arg.slice("--auth-state=".length);
      continue;
    }

    if (arg.startsWith("--browser-path=")) {
      options.browserPath = arg.slice("--browser-path=".length);
    }
  }

  return options;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
