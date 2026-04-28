import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_API_BASE_URL = "https://kazan-event-radar-api.4ereshny333.workers.dev";
const DEFAULT_REPORT_PATH = path.join(ROOT, "data", "catalog-moderation", "review-board.json");
const DEFAULT_STATE_PATH = path.join(ROOT, "data", "catalog-moderation", "telegram-draft-state.json");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".cloudflare.env"), override: false, quiet: true });

const options = parseArgs(process.argv.slice(2));

const reportPath = path.resolve(ROOT, options.report || DEFAULT_REPORT_PATH);
const statePath = path.resolve(ROOT, options.state || DEFAULT_STATE_PATH);
const apiBaseUrl = String(options.apiBase || process.env.WORKER_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
const automationToken = String(options.token || process.env.WORKER_AUTOMATION_TOKEN || process.env.AUTOMATION_TOKEN || "").trim();
const dryRun = Boolean(options.dryRun);
const limit = Number.isFinite(options.limit) ? options.limit : 10;
const pauseMs = Number.isFinite(options.pauseMs) ? Math.max(0, options.pauseMs) : 750;
const sectionFilter = new Set(String(options.section || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));

if (!dryRun && !automationToken) {
  throw new Error([
    "WORKER_AUTOMATION_TOKEN is required to send catalog card drafts.",
    "Set this environment variable first, then run:",
    "npm run catalog:moderation:send -- --limit=10"
  ].join("\n"));
}

const report = await readJson(reportPath, null);
if (!report?.sections?.length) {
  throw new Error(`Moderation report was not found or is empty: ${reportPath}`);
}

const state = await readJson(statePath, { sent: {}, updatedAt: null });
state.sent = state.sent && typeof state.sent === "object" ? state.sent : {};

const eligibleCandidates = flattenReport(report)
  .filter((entry) => !sectionFilter.size || sectionFilter.has(entry.sectionId))
  .filter((entry) => entry.photoCandidate?.sourceUrl);
const candidates = eligibleCandidates
  .filter((entry) => !state.sent[buildStateKey(entry)]);

const targetCount = limit > 0 ? limit : candidates.length;
let sent = 0;
let deduped = 0;
let failed = 0;
let reviewed = 0;

console.log(`Catalog photo drafts: up to ${targetCount}/${candidates.length} selected`);
console.log(`API: ${apiBaseUrl}`);
if (dryRun) console.log("Dry run: nothing will be sent.");

for (const entry of candidates) {
  if (sent >= targetCount) break;
  reviewed += 1;

  const payload = buildPayload(entry);
  const label = `${entry.sectionTitle} / ${entry.item.title}`;

  if (dryRun) {
    console.log(`[dry-run] ${label} -> ${entry.photoCandidate.sourceUrl}`);
    sent += 1;
    continue;
  }

  try {
    const result = await sendDraftWithRetry(payload);
    const stateKey = buildStateKey(entry);
    state.sent[stateKey] = {
      draftId: result.draftId || "",
      sectionId: entry.sectionId,
      itemId: entry.item.id,
      title: entry.item.title,
      photoUrl: entry.photoCandidate.sourceUrl,
      sentAt: new Date().toISOString(),
      deduped: Boolean(result.deduped)
    };
    state.updatedAt = new Date().toISOString();
    await writeJson(statePath, state);
    if (result.deduped) {
      deduped += 1;
      console.log(`[skip-duplicate] ${label}: ${result.draftId || "existing"}`);
    } else {
      sent += 1;
      console.log(`[sent] ${label}: ${result.draftId || "ok"}`);
    }
    if (pauseMs > 0) await sleep(pauseMs);
  } catch (error) {
    failed += 1;
    console.warn(`[failed] ${label}: ${error.message || error}`);
  }
}

if (!dryRun) {
  await writeJson(statePath, state);
}

if (dryRun) {
  console.log(`Done. Reviewed: ${reviewed}. Selected for dry run: ${sent}.`);
} else {
  console.log(`Done. Reviewed: ${reviewed}. Sent: ${sent}. Duplicates skipped: ${deduped}. Failed: ${failed}. Locally skipped already sent: ${eligibleCandidates.length - candidates.length}.`);
}

function flattenReport(report) {
  return report.sections.flatMap((section) => {
    const sectionId = section.sectionId || section.id || "";
    return (section.items || []).map((item) => ({
      sectionId,
      sectionTitle: section.title || sectionId,
      item,
      photoCandidate: item.photoCandidates?.[0] || null
    }));
  });
}

function buildPayload(entry) {
  const fields = {
    ...(entry.item.draft || {}),
    photoLinks: [
      {
        label: "Фото 1",
        url: entry.photoCandidate.sourceUrl
      }
    ]
  };

  return {
    sectionId: entry.sectionId,
    itemId: entry.item.id,
    fields,
    previewImageUrl: entry.photoCandidate.sourceUrl,
    previewImageAlt: entry.item.title
  };
}

async function sendDraft(payload) {
  const response = await fetch(`${apiBaseUrl}/internal/catalog-card-draft`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${automationToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok || body?.error) {
    throw new Error(body?.error || body?.message || `${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
  }

  return body || { ok: true };
}

async function sendDraftWithRetry(payload) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await sendDraft(payload);
    } catch (error) {
      lastError = error;
      const retryAfterSeconds = extractRetryAfterSeconds(error.message || "");
      if (!retryAfterSeconds || attempt === 3) break;
      const waitMs = Math.min(60_000, (retryAfterSeconds + 2) * 1000);
      console.warn(`[retry] Telegram rate limit, waiting ${Math.round(waitMs / 1000)}s before attempt ${attempt + 1}.`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function extractRetryAfterSeconds(message) {
  const jsonMatch = String(message || "").match(/"retry_after"\s*:\s*(\d+)/i);
  if (jsonMatch) return Number(jsonMatch[1]);
  const textMatch = String(message || "").match(/retry after\s+(\d+)/i);
  return textMatch ? Number(textMatch[1]) : 0;
}

function buildStateKey(entry) {
  return [
    entry.sectionId,
    entry.item.id,
    hashString(entry.photoCandidate?.sourceUrl || entry.photoCandidate?.file || "")
  ].join(":");
}

function hashString(value) {
  let hash = 5381;
  for (const char of String(value || "")) {
    hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  }
  return (hash >>> 0).toString(36);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseArgs(args) {
  const parsed = {};

  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (key === "limit") {
      parsed.limit = Number(value);
    } else if (key === "section") {
      parsed.section = value;
    } else if (key === "api-base") {
      parsed.apiBase = value;
    } else if (key === "token") {
      parsed.token = value;
    } else if (key === "report") {
      parsed.report = value;
    } else if (key === "state") {
      parsed.state = value;
    } else if (key === "pause-ms") {
      parsed.pauseMs = Number(value);
    }
  }

  return parsed;
}
