import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sourceConfig from "../config/sources.json" with { type: "json" };
import { mergeImportedPayloadToKv } from "./lib/import-payload-to-kv.mjs";
import { buildLocalSnapshotPayload } from "./lib/local-import-snapshot.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "data", "playwright", "kassir-browser-events.json");
const STATE_PATH = path.join(ROOT, "data", "playwright", "kassir-browser-state.json");
const PROFILE_DIR = path.join(ROOT, "data", "playwright", "kassir-profile");
const STATE_RETENTION_DAYS = 180;
const KASSIR_ANTI_BOT_CODE = "KASSIR_ANTI_BOT";
const cliOptions = parseCliOptions(process.argv.slice(2));

const KASSIR_SOURCES = (sourceConfig.sources || [])
  .filter((source) => source.enabled && source.type === "kassir_sitemap");

async function main() {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });

  const syncState = await loadSyncState();
  const existingSnapshotUrls = await loadExistingSnapshotUrls();
  const runStartedAt = new Date().toISOString();
  const importMode = resolveImportMode(cliOptions);
  const runMode = resolveRunMode(cliOptions);
  const shouldUpload = !cliOptions.noUpload;
  const activeSources = KASSIR_SOURCES
    .filter((source) => cliOptions.sourceIds.length === 0 || cliOptions.sourceIds.includes(source.id))
    .slice(0, cliOptions.maxSources || KASSIR_SOURCES.length);

  if (!activeSources.length) {
    throw new Error("No enabled Kassir sources matched the current filters.");
  }

  const authStatePath = await resolveOptionalAuthStatePath(cliOptions.authStatePath);
  const context = await launchBrowserContext(authStatePath);
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(180000);
  await page.setExtraHTTPHeaders({
    "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
  });

  try {
    const collected = [];
    const stats = [];
    const runFlags = {
      stoppedEarly: false,
      antiBotTriggered: false,
      blockedLink: "",
      blockedSourceId: ""
    };

    for (const source of activeSources) {
      console.log(`Collecting source: ${source.id}`);
      const links = await collectSourceLinks(source, cliOptions.maxLinksPerSource);
      const sourceState = getSourceStateBucket(syncState, source);
      markLinksDiscovered(sourceState, links, runStartedAt);

      const queuedLinks = pickLinksForCollection(links, sourceState, cliOptions, existingSnapshotUrls);
      console.log(`Found links: ${links.length}`);
      console.log(`Queued links: ${queuedLinks.length}${cliOptions.incremental ? " (new only)" : ""}`);

      let importedForSource = 0;
      let processedForSource = 0;
      let sourceStoppedEarly = false;
      const chunks = chunkItems(queuedLinks, Math.max(1, cliOptions.chunkSize || queuedLinks.length || 1));

      sourceLoop:
      for (const [chunkIndex, chunk] of chunks.entries()) {
        if (chunkIndex > 0) {
          const cooldownMs = resolveChunkCooldownMs(cliOptions.pauseMs);
          console.log(`Cooling down before chunk ${chunkIndex + 1}/${chunks.length} (${cooldownMs} ms)...`);
          await pause(cooldownMs);
        }

        for (const link of chunk) {
          processedForSource += 1;
          console.log(`  [${processedForSource}/${queuedLinks.length}] ${link}`);

          if (processedForSource > 1 && cliOptions.pauseMs > 0) {
            await pause(cliOptions.pauseMs);
          }

          let event = null;
          try {
            event = await collectEventDetails(page, link, source);
          } catch (error) {
            if (isKassirAntiBotError(error)) {
              markLinkBlocked(sourceState, link, runStartedAt);
              sourceStoppedEarly = true;
              runFlags.stoppedEarly = true;
              runFlags.antiBotTriggered = true;
              runFlags.blockedLink = link;
              runFlags.blockedSourceId = source.id;
              console.warn("Kassir anti-bot appeared again. Stopping the current batch early to preserve the session.");
              console.warn(error.message);
              break sourceLoop;
            }

            throw error;
          }

          if (!event?.title) continue;
          importedForSource += 1;
          collected.push(event);
          markLinkCollected(sourceState, event, runStartedAt, shouldUpload);
        }
      }

      stats.push({
        id: source.id,
        name: source.name,
        collectedLinks: links.length,
        queuedLinks: queuedLinks.length,
        skippedKnownLinks: Math.max(0, links.length - queuedLinks.length),
        processedLinks: processedForSource,
        importedItems: importedForSource,
        remainingLinks: Math.max(0, queuedLinks.length - processedForSource),
        stoppedEarly: sourceStoppedEarly,
        antiBotTriggered: sourceStoppedEarly
      });

      if (sourceStoppedEarly) {
        break;
      }
    }

    const deduped = dedupeImportedEvents(collected).filter(isValidKassirPayloadEvent);
    const uploadPayload = {
      source: "kassir_browser",
      mode: importMode,
      runMode,
      syncedAt: new Date().toISOString(),
      sourceStats: stats,
      reportedImportedCount: deduped.length,
      items: deduped
    };
    const snapshotPayload = repairKassirPayload(await buildLocalSnapshotPayload(OUTPUT_PATH, uploadPayload, {
      mode: runFlags.stoppedEarly ? "incremental" : runMode
    }));

    await writeOutputSnapshot(OUTPUT_PATH, snapshotPayload, console.log, "Kassir browser events");
    console.log(`Output: ${OUTPUT_PATH}`);

    let uploadResult = null;
    if (shouldUpload) {
      if (deduped.length) {
        uploadResult = await mergeImportedPayloadToKv(uploadPayload, {
          log: console.log
        });
        markEventsUploaded(syncState, collected, new Date().toISOString());
        console.log(`Uploaded Kassir browser events: ${uploadResult.imported || 0}`);
      } else {
        console.log("Skip upload: no prepared events for this run.");
      }
    }

    if (cliOptions.noUpload) {
      clearNoUploadPendingLinks(syncState);
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
      snapshotItems: snapshotPayload.items.length,
      uploadedItems: uploadResult?.imported || 0,
      stoppedEarly: runFlags.stoppedEarly,
      antiBotTriggered: runFlags.antiBotTriggered,
      blockedLink: runFlags.blockedLink || null,
      blockedSourceId: runFlags.blockedSourceId || null,
      outputPath: path.relative(ROOT, OUTPUT_PATH)
    });

    pruneSyncState(syncState, new Date());
    await saveSyncState(syncState);
    console.log(`State: ${STATE_PATH}`);
  } finally {
    await context.close().catch(() => null);
  }
}

async function collectSourceLinks(source, overrideLimit = null) {
  const sitemapXml = await fetchText(source.url);
  const allLinks = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
    .map((match) => decodeXml(match[1]))
    .map((url) => canonicalEventUrl(url))
    .filter(Boolean)
    .filter(isKassirEventUrl)
    .filter((url) => isKassirEventInAllowedWindow(url));
  const prioritizedLinks = prioritizeKassirLinks(allLinks);

  const requestedLimit = overrideLimit == null ? Number(source.limit || 0) : Number(overrideLimit);
  const unlimited = !requestedLimit || requestedLimit < 0;
  return unlimited ? prioritizedLinks : prioritizedLinks.slice(0, requestedLimit);
}

async function collectEventDetails(page, link, source) {
  for (let attempt = 1; attempt <= Math.max(1, cliOptions.retries || 1); attempt += 1) {
    try {
      await gotoAndSettle(page, link);
      await assertNoKassirAntiBot(page, link);

      const rawDetails = await page.evaluate(() => {
      const normalize = (value) => String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const unique = (values) => [...new Set(values.map(normalize).filter(Boolean))];
      const text = (node) => normalize(node?.textContent || '');
      const meta = (name, attr = 'property') => normalize(document.querySelector(
        'meta[' + attr + '="' + name + '"]'
      )?.content || '');
      const h1 = document.querySelector('h1');
      const bodyText = normalize(document.body?.innerText || '');
      const venueHintRe = /(?:\u043f\u043b\u043e\u0449\u0430\u0434\u043a\u0430|\u043c\u0435\u0441\u0442\u043e\s+\u043f\u0440\u043e\u0432\u0435\u0434\u0435\u043d\u0438\u044f|\u0442\u0435\u0430\u0442\u0440|\u0430\u0440\u0435\u043d\u0430|\u0434\u043a|\u043a\u043b\u0443\u0431|\u0444\u0438\u043b\u0430\u0440\u043c\u043e\u043d\u0438\u044f|\u043a\u0440\u0435\u043c\u043b\u044c|\u043f\u0438\u0440\u0430\u043c\u0438\u0434\u0430)/i;
      const timeHintRe = /(?:\u043d\u0430\u0447\u0430\u043b\u043e|\u0432\u0440\u0435\u043c\u044f|\u0441\u0442\u0430\u0440\u0442)\s*[:\-]?\s*(\d{1,2}:\d{2})/i;

      const parseJsonLd = () => {
        const nodes = [...document.querySelectorAll('script[type="application/ld+json"]')];
        const queue = [];

        for (const node of nodes) {
          try {
            const parsed = JSON.parse(node.textContent || 'null');
            queue.push(parsed);
          } catch {
            // ignore broken json
          }
        }

        const flat = [];
        const pushValue = (value) => {
          if (!value) return;
          if (Array.isArray(value)) {
            value.forEach(pushValue);
            return;
          }
          if (typeof value !== 'object') return;
          flat.push(value);
          if (value['@graph']) pushValue(value['@graph']);
        };

        queue.forEach(pushValue);
        return flat.find((item) => String(item['@type'] || '').toLowerCase().includes('event')) || null;
      };

      const extractStrings = (value) => {
        const values = [];
        const push = (input) => {
          if (!input) return;
          if (Array.isArray(input)) {
            input.forEach(push);
            return;
          }
          if (typeof input === 'string') {
            const normalized = normalize(input);
            if (normalized) values.push(normalized);
            return;
          }
          if (typeof input !== 'object') return;
          push(input.url);
          push(input.contentUrl);
          push(input.image);
          push(input.src);
          push(input['@id']);
        };

        push(value);
        return unique(values);
      };

      const eventLd = parseJsonLd();
      const imageCandidates = unique([
        ...extractStrings(eventLd?.image),
        meta('og:image'),
        meta('twitter:image'),
        document.querySelector('img[src*="upload"], img[src*="media"], img[src*="image"]')?.src || ''
      ]);

      const venueCandidates = unique([
        eventLd?.location?.name,
        ...[...document.querySelectorAll('a,button,div,span,p')]
          .map((node) => text(node))
          .filter((value) => value && venueHintRe.test(value))
          .slice(0, 6)
      ]);

      const descriptionCandidates = unique([
        eventLd?.description,
        meta('description', 'name'),
        meta('og:description'),
        ...[...document.querySelectorAll('[itemprop="description"], [class*="description"], [class*="about"], main p, article p')]
          .map((node) => text(node))
          .filter((value) => value.length >= 60)
          .slice(0, 8)
      ]);

      const titleCandidates = unique([
        eventLd?.name,
        text(h1),
        meta('og:title'),
        meta('twitter:title', 'name'),
        document.title
      ]);

      const startDateCandidates = unique([
        eventLd?.startDate,
        eventLd?.offers?.validFrom
      ]);

      const timeMatch = bodyText.match(timeHintRe);

      return {
        titleCandidates,
        summaryCandidates: descriptionCandidates,
        imageCandidates,
        venueCandidates,
        startDateCandidates,
        timeText: normalize(timeMatch?.[1] || ''),
        sourceLabel: 'kzn.kassir.ru',
        url: location.href
      };
    });

    const details = repairKassirDetails(rawDetails);
    const resolvedSummary = resolveKassirSummary(details.summaryCandidates);
    const resolvedTitle = resolveKassirTitle(details.titleCandidates, resolvedSummary);
    if (!resolvedTitle) {
      throw new Error('Unable to resolve event title.');
    }

      const parsedDate = parseKassirEventDate(link, details.startDateCandidates, details.timeText, resolvedSummary);

      return {
        sourceId: source.id,
        sourceName: source.name,
        title: resolvedTitle,
        subtitle: '',
        summary: resolvedSummary || resolvedTitle,
        shortSummary: buildKassirShortSummary(resolvedSummary || resolvedTitle),
        imageUrl: resolveKassirImageUrl(link, details.imageCandidates),
        venueTitle: resolveKassirVenueTitle(details.venueCandidates, resolvedSummary),
        venueUrl: '',
        sourceLabel: details.sourceLabel || 'kzn.kassir.ru',
        section: mapKassirSection(link),
        url: canonicalEventUrl(details.url || link),
        eventDate: parsedDate?.iso || null,
        eventHasExplicitTime: Boolean(parsedDate?.hasExplicitTime),
        dateText: parsedDate?.label || ''
      };
    } catch (error) {
      if (isKassirAntiBotError(error)) {
        throw error;
      }

      const isLastAttempt = attempt >= Math.max(1, cliOptions.retries || 1);
      if (isLastAttempt) {
        console.warn('Skip Kassir event: ' + link);
        console.warn(error.message);
        return null;
      }

      const retryDelayMs = resolveRetryDelayMs(attempt, cliOptions.pauseMs);
      console.warn(`Retry Kassir event (${attempt}/${cliOptions.retries}): ${link}`);
      console.warn(`Reason: ${error.message}`);
      console.warn(`Waiting ${retryDelayMs} ms before retry...`);
      await pause(retryDelayMs);
    }
  }
}

async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(1800);
}

async function assertNoKassirAntiBot(page, link) {
  const snapshot = await page.evaluate(() => ({
    currentUrl: location.href,
    title: document.title || "",
    bodyText: document.body?.innerText || ""
  })).catch(() => ({
    currentUrl: page.url(),
    title: "",
    bodyText: ""
  }));

  if (!isKassirAntiBotSnapshot(snapshot)) {
    return;
  }

  throw createKassirAntiBotError(link, snapshot.currentUrl || page.url());
}

function isKassirAntiBotSnapshot(snapshot) {
  const currentUrl = String(snapshot?.currentUrl || "");
  const title = normalizeText(snapshot?.title || "");
  const bodyText = normalizeText(snapshot?.bodyText || "");
  const combined = `${title} ${bodyText}`;

  return /fg\.kassir\.ru/i.test(currentUrl)
    || /(?:\u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044f\s+\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435|\u043d\u0435\u043e\u0431\u0445\u043e\u0434\u0438\u043c\u043e\s+\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0435|\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430\s+\u0431\u0435\u0437\u043e\u043f\u0430\u0441\u043d\u043e\u0441\u0442\u0438)/i.test(combined)
    || /(?:captcha|cloudflare|attention required|verify you are human|checking your browser)/i.test(combined);
}

function createKassirAntiBotError(link, currentUrl = "") {
  const error = new Error(
    `Kassir anti-bot page is active for ${link}. Current URL: ${currentUrl || "unknown"}. ` +
    "Run npm run kassir:browser:warmup, complete the check in the opened browser, close the window, and rerun the sync."
  );
  error.code = KASSIR_ANTI_BOT_CODE;
  return error;
}

function isKassirAntiBotError(error) {
  return error?.code === KASSIR_ANTI_BOT_CODE;
}

function resolveRetryDelayMs(attempt, pauseMs) {
  const base = Math.max(1200, Number(pauseMs || 0));
  return base * Math.max(1, attempt);
}

function resolveChunkCooldownMs(pauseMs) {
  return Math.max(2500, Math.round(Math.max(0, Number(pauseMs || 0)) * 2.5));
}

function chunkItems(items, chunkSize) {
  const size = Math.max(1, Number(chunkSize || 1));
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function pause(ms) {
  const delayMs = Math.max(0, Number(ms || 0));
  if (!delayMs) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
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
    source: "kassir_browser_state",
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
        blockedAt: entry?.blockedAt || null,
        blockedCount: Number(entry?.blockedCount || 0),
        title: repairKassirMojibake(entry?.title || ""),
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
      blockedAt: null,
      blockedCount: 0,
      title: "",
      eventDate: null
    };

    current.lastSeenAt = nowIso;
    bucket.links[link] = current;
  }
}

async function loadExistingSnapshotUrls() {
  try {
    const raw = await fs.readFile(OUTPUT_PATH, "utf8");
    const payload = JSON.parse(raw);
    return new Set((payload.items || []).map((item) => canonicalEventUrl(item?.url)).filter(Boolean));
  } catch {
    return new Set();
  }
}

function pickLinksForCollection(links, bucket, options, existingSnapshotUrls = new Set()) {
  if (!options.incremental) return links;

  return links.filter((rawLink) => {
    const link = canonicalEventUrl(rawLink);
    const current = bucket.links[link];
    if (!current) return true;
    if (shouldSkipTemporarilyBlockedLink(current)) return false;
    if (!existingSnapshotUrls.has(link)) return true;
    return current.pendingUpload || !current.collectedAt;
  });
}

function shouldSkipTemporarilyBlockedLink(entry) {
  if (Number(entry?.blockedCount || 0) < 2 || !entry?.blockedAt) return false;

  const blockedAt = new Date(entry.blockedAt);
  if (Number.isNaN(blockedAt.getTime())) return false;

  const blockedForMs = Date.now() - blockedAt.getTime();
  return blockedForMs >= 0 && blockedForMs < 12 * 60 * 60 * 1000;
}

function markLinkCollected(bucket, event, nowIso, pendingUpload = true) {
  const link = canonicalEventUrl(event?.url);
  if (!link) return;

  const current = bucket.links[link] || {
    url: link,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    collectedAt: null,
    uploadedAt: null,
    pendingUpload: false,
    blockedAt: null,
    blockedCount: 0,
    title: "",
    eventDate: null
  };

  current.lastSeenAt = nowIso;
  current.collectedAt = nowIso;
  current.pendingUpload = Boolean(pendingUpload);
  current.blockedAt = null;
  current.blockedCount = 0;
  current.title = event?.title || current.title || "";
  current.eventDate = event?.eventDate || current.eventDate || null;
  bucket.links[link] = current;
  bucket.updatedAt = nowIso;
}

function markLinkBlocked(bucket, rawLink, nowIso) {
  const link = canonicalEventUrl(rawLink);
  if (!link) return;

  const current = bucket.links[link] || {
    url: link,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    collectedAt: null,
    uploadedAt: null,
    pendingUpload: false,
    blockedAt: null,
    blockedCount: 0,
    title: "",
    eventDate: null
  };

  current.lastSeenAt = nowIso;
  current.blockedAt = nowIso;
  current.blockedCount = Number(current.blockedCount || 0) + 1;
  bucket.links[link] = current;
  bucket.updatedAt = nowIso;
}

function clearNoUploadPendingLinks(state) {
  for (const bucket of Object.values(state.sources || {})) {
    for (const entry of Object.values(bucket?.links || {})) {
      if (!entry?.collectedAt || entry.uploadedAt) continue;
      entry.pendingUpload = false;
    }
  }
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

async function resolveOptionalAuthStatePath(overridePath = "") {
  const candidates = [
    overridePath,
    process.env.KASSIR_AUTH_STATE_PATH,
    process.env.PLAYWRIGHT_AUTH_STATE_PATH,
    "data/playwright/kassir-state.json",
    "data/playwright/auth-state.json"
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

  return "";
}

async function launchBrowserContext(authStatePath = "") {
  const executablePath = await findBrowserExecutable();
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: cliOptions.headless,
    executablePath,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    viewport: { width: 1440, height: 1200 },
    ...(authStatePath ? { storageState: authStatePath } : {})
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

  throw new Error("Browser executable was not found. Install Chrome/Edge/Yandex Browser or pass --browser-path=...");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

function isKassirEventUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return false;

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 3) return false;
  if (!/_\d{4}-\d{2}-\d{2}$/i.test(parts[parts.length - 1])) return false;

  return [
    "koncert",
    "teatr",
    "shou",
    "standup",
    "sport",
    "vystavki",
    "ekskursii",
    "festivali",
    "detyam",
    "bilety-na-koncert",
    "bilety-v-teatr",
    "bilety-na-shou",
    "bilety-na-standup",
    "bilety-na-sportivnye-meropriyatiya",
    "bilety-na-vystavki",
    "bilety-na-ekskursii",
    "bilety-na-festival",
    "detskaya-afisha",
    "bilety-v-muzei",
    "muzei",
    "muzey",
    "bilety-for-tourists",
    "tourist",
    "open-air",
    "cirki",
    "drugoe",
    "bilety-na-drugoe",
    "obrazovanie",
    "obrazovanie-i-kursy"
  ].includes(parts[0]);
}

function isKassirEventInAllowedWindow(url) {
  const parsed = parseDateFromKassirUrl(url);
  if (!parsed) return false;

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const max = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59));
  return parsed >= today && parsed <= max;
}

const KASSIR_TITLE_STOP_WORDS = new Set([
  '\u0431\u0438\u043b\u0435\u0442\u044b',
  '\u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u0435',
  '\u043a\u0430\u0437\u0430\u043d\u044c',
  '\u043a\u0430\u0437\u0430\u043d\u0438',
  '\u043a\u0443\u043f\u0438\u0442\u044c',
  '\u043a\u043e\u043d\u0446\u0435\u0440\u0442',
  '\u0441\u043f\u0435\u043a\u0442\u0430\u043a\u043b\u044c',
  '\u0448\u043e\u0443',
  '\u043c\u0435\u0440\u043e\u043f\u0440\u0438\u044f\u0442\u0438\u0435',
  '\u0441\u043e\u0431\u044b\u0442\u0438\u0435',
  '\u0430\u0444\u0438\u0448\u0430',
  '\u0442\u0435\u0430\u0442\u0440'
]);

const CP1251_SPECIAL_BYTES = new Map([
  [0x0402, 0x80], [0x0403, 0x81], [0x201A, 0x82], [0x0453, 0x83],
  [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x20AC, 0x88], [0x2030, 0x89], [0x0409, 0x8A], [0x2039, 0x8B],
  [0x040A, 0x8C], [0x040C, 0x8D], [0x040B, 0x8E], [0x040F, 0x8F],
  [0x0452, 0x90], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93],
  [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x2122, 0x99], [0x0459, 0x9A], [0x203A, 0x9B], [0x045A, 0x9C],
  [0x045C, 0x9D], [0x045B, 0x9E], [0x045F, 0x9F], [0x00A0, 0xA0],
  [0x040E, 0xA1], [0x045E, 0xA2], [0x0408, 0xA3], [0x00A4, 0xA4],
  [0x0490, 0xA5], [0x00A6, 0xA6], [0x00A7, 0xA7], [0x0401, 0xA8],
  [0x00A9, 0xA9], [0x0404, 0xAA], [0x00AB, 0xAB], [0x00AC, 0xAC],
  [0x00AD, 0xAD], [0x00AE, 0xAE], [0x0407, 0xAF], [0x00B0, 0xB0],
  [0x00B1, 0xB1], [0x0406, 0xB2], [0x0456, 0xB3], [0x0491, 0xB4],
  [0x00B5, 0xB5], [0x00B6, 0xB6], [0x00B7, 0xB7], [0x0451, 0xB8],
  [0x2116, 0xB9], [0x0454, 0xBA], [0x00BB, 0xBB], [0x0458, 0xBC],
  [0x0405, 0xBD], [0x0455, 0xBE], [0x0457, 0xBF]
]);

function repairKassirDetails(details = {}) {
  return {
    ...details,
    titleCandidates: repairKassirStringArray(details.titleCandidates),
    summaryCandidates: repairKassirStringArray(details.summaryCandidates),
    venueCandidates: repairKassirStringArray(details.venueCandidates),
    timeText: repairKassirMojibake(details.timeText || ""),
    sourceLabel: repairKassirMojibake(details.sourceLabel || "")
  };
}

function repairKassirPayload(payload = {}) {
  return {
    ...payload,
    items: (payload.items || []).map(repairKassirEvent).filter(isValidKassirPayloadEvent)
  };
}

function repairKassirEvent(event = {}) {
  return {
    ...event,
    title: repairKassirMojibake(event.title || ""),
    subtitle: repairKassirMojibake(event.subtitle || ""),
    summary: repairKassirMojibake(event.summary || ""),
    shortSummary: repairKassirMojibake(event.shortSummary || ""),
    venueTitle: repairKassirMojibake(event.venueTitle || ""),
    sourceLabel: repairKassirMojibake(event.sourceLabel || ""),
    dateText: repairKassirMojibake(event.dateText || "")
  };
}

function isValidKassirPayloadEvent(event = {}) {
  const combinedText = `${event.title || ""} ${event.summary || ""}`;
  return Boolean(event.title)
    && isKassirEventUrl(event.url)
    && !looksLikeKassirGenericListingText(combinedText);
}

function repairKassirStringArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => repairKassirMojibake(value));
}

function repairKassirMojibake(value) {
  const text = String(value || "");
  if (!looksLikeKassirMojibake(text)) return text;

  const bytes = [];
  for (const char of text) {
    const byte = cp1251ByteFromChar(char);
    if (byte == null) return text;
    bytes.push(byte);
  }

  const repaired = Buffer.from(bytes).toString("utf8");
  if (!repaired || repaired.includes("\uFFFD")) return text;

  const originalNoise = countKassirMojibakeNoise(text);
  const repairedNoise = countKassirMojibakeNoise(repaired);
  const repairedCyrillic = countCyrillicLetters(repaired);

  return repairedNoise < originalNoise && repairedCyrillic >= 1
    ? repaired
    : text;
}

function looksLikeKassirMojibake(text) {
  return countKassirMojibakeNoise(text) >= 2
    || /(?:[РС][\u0400-\u04FF]|в[\u0400-\u04FF\u2018-\u2122\u00A0-\u00BF])/u.test(text);
}

function countKassirMojibakeNoise(text) {
  return (String(text || "").match(/(?:[РС][\u0400-\u04FF]|в[\u0400-\u04FF\u2018-\u2122\u00A0-\u00BF])/gu) || []).length;
}

function countCyrillicLetters(text) {
  return (String(text || "").match(/[А-Яа-яЁё]/g) || []).length;
}

function cp1251ByteFromChar(char) {
  const code = char.codePointAt(0);
  if (code <= 0x7F) return code;
  if (code >= 0x0410 && code <= 0x044F) return code - 0x0350;
  if (code >= 0x00A0 && code <= 0x00BF) return code;
  return CP1251_SPECIAL_BYTES.get(code) ?? null;
}

function parseKassirEventDate(url, startDateCandidates = [], timeText = '', summary = '') {
  const urlDate = parseDateFromKassirUrl(url);
  const parsedStarts = uniqueNormalizedStrings(startDateCandidates)
    .map(parseKassirStartDateCandidate)
    .filter(Boolean);

  const matchedStart = parsedStarts.find((candidate) => urlDate && sameMoscowDate(candidate.date, urlDate))
    || parsedStarts[0]
    || null;

  const parsedTime = parseTimeCandidate(timeText)
    || parseTimeFromText(summary)
    || (matchedStart?.hasExplicitTime ? { hour: matchedStart.hour, minute: matchedStart.minute } : null);

  const baseDate = urlDate || matchedStart?.date || null;
  if (!baseDate) return null;

  const hour = parsedTime?.hour ?? 12;
  const minute = parsedTime?.minute ?? 0;
  const hasExplicitTime = Boolean(parsedTime);

  return {
    iso: new Date(Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth(),
      baseDate.getUTCDate(),
      hour - 3,
      minute,
      0
    )).toISOString(),
    hasExplicitTime,
    label: formatKassirDateLabel(baseDate, hasExplicitTime ? { hour, minute } : null)
  };
}

function parseDateFromKassirUrl(url) {
  const match = String(url || '').match(/_(\d{4})-(\d{2})-(\d{2})$/i);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0));
}

function prioritizeKassirLinks(links) {
  const uniqueLinks = [...new Set((links || []).filter(Boolean))];
  const buckets = new Map();

  for (const link of uniqueLinks) {
    const section = mapKassirSection(link);
    if (!buckets.has(section)) {
      buckets.set(section, []);
    }
    buckets.get(section).push(link);
  }

  const sortedSections = [...buckets.keys()].sort(compareKassirSections);
  for (const section of sortedSections) {
    buckets.get(section).sort(compareKassirLinks);
  }

  const prioritized = [];
  let hasRemaining = true;

  while (hasRemaining) {
    hasRemaining = false;

    for (const section of sortedSections) {
      const bucket = buckets.get(section);
      if (!bucket?.length) continue;
      prioritized.push(bucket.shift());
      hasRemaining = true;
    }
  }

  return prioritized;
}

function compareKassirLinks(left, right) {
  const leftDate = parseDateFromKassirUrl(left);
  const rightDate = parseDateFromKassirUrl(right);
  const leftTime = leftDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightTime = rightDate?.getTime() ?? Number.MAX_SAFE_INTEGER;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return String(left || "").localeCompare(String(right || ""), "ru");
}

function compareKassirSections(left, right) {
  return kassirSectionPriority(left) - kassirSectionPriority(right)
    || String(left || "").localeCompare(String(right || ""), "ru");
}

function kassirSectionPriority(section) {
  return {
    concert: 0,
    theatre: 1,
    show: 2,
    standup: 3,
    sport: 4,
    exhibition: 5,
    excursion: 6,
    kids: 7,
    events: 8
  }[section] ?? 99;
}

function resolveKassirTitle(titleCandidates, summary = '') {
  const candidates = uniqueNormalizedStrings(titleCandidates)
    .map(cleanupKassirTitleCandidate)
    .filter((value) => isMeaningfulKassirText(value));

  const bySummary = candidates.find((value) => !looksLikeKassirMetaTitle(value) && hasKassirTokenOverlap(value, summary));
  if (bySummary) return bySummary;

  const clean = candidates.find((value) => !looksLikeKassirMetaTitle(value));
  if (clean) return clean;

  return deriveKassirTitleFromSummary(summary) || candidates[0] || '';
}

function resolveKassirSummary(summaryCandidates) {
  const candidates = uniqueNormalizedStrings(summaryCandidates)
    .map((value) => trimKassirText(value, 1400))
    .filter((value) => isMeaningfulKassirText(value));

  const long = candidates.find((value) => value.length >= 80);
  return long || candidates[0] || '';
}

function resolveKassirVenueTitle(venueCandidates, summary = '') {
  const candidates = uniqueNormalizedStrings(venueCandidates)
    .map((value) => trimKassirText(value, 120))
    .filter((value) => isMeaningfulKassirText(value))
    .filter((value) => value.length <= 100)
    .filter((value) => !/(?:\u043a\u0443\u043f\u0438\u0442\u044c\s+\u0431\u0438\u043b\u0435\u0442\u044b|\u043f\u043e\u0434\u0440\u043e\u0431\u043d\u0435\u0435|\u043e\u043f\u0438\u0441\u0430\u043d\u0438\u0435)/i.test(value));

  const bySummary = candidates.find((value) => hasKassirTokenOverlap(value, summary));
  return bySummary || candidates[0] || '';
}

function resolveKassirImageUrl(origin, imageCandidates) {
  for (const candidate of uniqueNormalizedStrings(imageCandidates)) {
    const url = canonicalAssetUrl(origin, candidate);
    if (!url) continue;
    if (/\[object Object\]/i.test(url)) continue;
    if (/\.(png|jpe?g|webp|gif)(?:$|[?#])/i.test(url) || /image|upload|media|avatar|poster|cover/i.test(url)) {
      return url;
    }
  }

  return '';
}

function buildKassirShortSummary(summary) {
  return trimKassirSentences(summary, 2, 240);
}

function cleanupKassirTitleCandidate(value) {
  return trimKassirText(String(value || '')
    .replace(/\s*[|?].*$/g, '')
    .replace(/^(?:\u043a\u0443\u043f\u0438\u0442\u044c\s+\u0431\u0438\u043b\u0435\u0442\u044b\s+\u043d\u0430)\s+/i, '')
    .replace(/^(?:\u0431\u0438\u043b\u0435\u0442\u044b\s+\u043d\u0430)\s+/i, '')
    .replace(/^(?:\u0431\u0438\u043b\u0435\u0442\u044b\s+\u0432)\s+/i, '')
    .replace(/\s+(?:\u0432\s+\u043a\u0430\u0437\u0430\u043d\u0438).*$/i, '')
    .replace(/\s+\d{1,2}\.\d{2}\.\d{4}.*$/i, ''), 140);
}

function deriveKassirTitleFromSummary(summary) {
  const parts = String(summary || '')
    .split(/[,.!?:;\n]+/)
    .map((value) => cleanupKassirTitleCandidate(value))
    .filter(Boolean);

  return parts.find((value) => value.length >= 3 && value.length <= 100) || '';
}

function parseKassirStartDateCandidate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const parsed = new Date(/Z$/i.test(raw) || /[+-]\d{2}:\d{2}$/i.test(raw) ? raw : raw + '+03:00');
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = getMoscowDateParts(parsed);
  return {
    raw,
    date: new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0)),
    hour: parts.hour,
    minute: parts.minute,
    hasExplicitTime: /\d{2}:\d{2}/.test(raw)
  };
}

function parseTimeFromText(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

function parseTimeCandidate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

function sameMoscowDate(left, right) {
  return formatMoscowDateKey(left) === formatMoscowDateKey(right);
}

function formatMoscowDateKey(value) {
  const parts = getMoscowDateParts(value);
  return [parts.year, String(parts.month).padStart(2, '0'), String(parts.day).padStart(2, '0')].join('-');
}

function formatKassirDateLabel(date, time = null) {
  const dateLabel = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long'
  }).format(date);

  return time ? dateLabel + ', ' + formatTimeValue(time.hour, time.minute) : dateLabel;
}

function getMoscowDateParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(value instanceof Date ? value : new Date(value));

  const lookup = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute)
  };
}

function formatTimeValue(hour, minute) {
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function uniqueNormalizedStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function hasKassirTokenOverlap(left, right) {
  const leftTokens = tokenizeKassirText(left);
  const rightTokens = tokenizeKassirText(right);
  if (!leftTokens.size || !rightTokens.size) return false;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) return true;
  }

  return false;
}

function tokenizeKassirText(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !KASSIR_TITLE_STOP_WORDS.has(token))
  );
}

function isMeaningfulKassirText(value) {
  const text = normalizeText(value);
  if (!text || text.length < 3) return false;
  if (/\[object Object\]/i.test(text)) return false;
  if (/(?:\u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044f\s+\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435|\u043d\u0435\u043e\u0431\u0445\u043e\u0434\u0438\u043c\u043e\s+\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0435|robot|captcha)/i.test(text)) return false;
  if (looksLikeKassirGenericListingText(text)) return false;
  return true;
}

function looksLikeKassirGenericListingText(value) {
  return /(?:\u0430\u0444\u0438\u0448\u0430\s+\u043a\u0430\u0437\u0430\u043d\u0438|\u043a\u0443\u0434\u0430\s+\u0441\u0445\u043e\u0434\u0438\u0442\u044c|\u0443\u0434\u043e\u0431\u043d\u044b\u0439\s+\u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c\s+\u0441\u043e\u0431\u044b\u0442\u0438\u0439|\u043a\u043e\u043d\u0441\u0443\u043b\u044c\u0442\u0430\u0446\u0438\u044f\s+\u043f\u043e\s+\u043f\u0440\u043e\u0434\u0430\u0436\u0435\s+\u0431\u0438\u043b\u0435\u0442\u043e\u0432)/i.test(String(value || ""));
}

function looksLikeKassirMetaTitle(value) {
  return /(?:\u043a\u0443\u043f\u0438\u0442\u044c\s+\u0431\u0438\u043b\u0435\u0442\u044b|kassir|\u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u0435\s+\u0431\u0438\u043b\u0435\u0442\u044b)/i.test(String(value || ''));
}

function trimKassirText(value, maxLength = 400) {
  const text = normalizeText(value)
    .replace(/^[-??:;,\s]+/, '')
    .replace(/[-??:;,\s]+$/, '');

  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).replace(/[\s,;:.!?-]+$/g, '') + '?';
}

function trimKassirSentences(value, sentenceCount = 2, maxLength = 240) {
  const text = normalizeText(value);
  if (!text) return '';

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (!sentences.length) return trimKassirText(text, maxLength);

  return trimKassirText(sentences.slice(0, sentenceCount).join(' '), maxLength);
}

function mapKassirSection(url) {
  const segment = safeUrl(url)?.pathname.split("/").filter(Boolean)[0] || "";

  return {
    "koncert": "concert",
    "bilety-na-koncert": "concert",
    "teatr": "theatre",
    "bilety-v-teatr": "theatre",
    "shou": "show",
    "bilety-na-shou": "show",
    "festivali": "show",
    "bilety-na-festival": "show",
    "open-air": "show",
    "cirki": "show",
    "standup": "standup",
    "bilety-na-standup": "standup",
    "sport": "sport",
    "bilety-na-sportivnye-meropriyatiya": "sport",
    "vystavki": "exhibition",
    "bilety-na-vystavki": "exhibition",
    "muzei": "exhibition",
    "muzey": "exhibition",
    "bilety-v-muzei": "exhibition",
    "ekskursii": "excursion",
    "bilety-na-ekskursii": "excursion",
    "bilety-for-tourists": "excursion",
    "tourist": "excursion",
    "teplohody": "excursion",
    "detyam": "kids",
    "detskaya-afisha": "kids",
    "obrazovanie": "events",
    "obrazovanie-i-kursy": "events",
    "drugoe": "events",
    "bilety-na-drugoe": "events"
  }[segment] || "events";
}

function canonicalEventUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw, "https://kzn.kassir.ru");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function canonicalAssetUrl(origin, value) {
  const raw = String(value || '').trim();
  if (!raw || /\[object Object\]/i.test(raw)) return '';

  try {
    return new URL(raw, origin).toString();
  } catch {
    return '';
  }
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

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function safeUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
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
