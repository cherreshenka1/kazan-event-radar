import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sourceConfig from "../../config/sources.json" with { type: "json" };
import { IMPORT_INTERNALS } from "../../worker/src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const TMP_DIR = path.join(ROOT, "data", "playwright", ".tmp");
const WRANGLER_CONFIG = path.join(ROOT, "worker", "wrangler.toml");
const WRANGLER_ENV_FILE = path.join(ROOT, ".cloudflare.env");
const execFileAsync = promisify(execFile);

export async function mergeImportedPayloadToKv(payload = {}, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const sourceKey = String(payload.source || "browser_import");
  const sourceType = IMPORT_INTERNALS.mapImportedSourceType(sourceKey);
  const sourceName = IMPORT_INTERNALS.mapImportedSourceName(sourceKey);
  const importMode = IMPORT_INTERNALS.normalizeExternalImportMode(payload.mode);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const reportedImportedCount = Math.max(0, Number(payload.reportedImportedCount || 0)) || items.length;
  const existingItems = await readRemoteJson("events:items", []);

  if (!items.length) {
    return {
      ok: true,
      source: sourceKey,
      mode: importMode,
      imported: 0,
      totalItems: existingItems.length
    };
  }

  const existing = (existingItems || [])
    .filter((item) => IMPORT_INTERNALS.PERSISTED_EVENT_TYPES.has(item.type))
    .filter((item) => importMode === "replace_source" ? item.type !== sourceType : true);

  const prepared = [];
  for (const raw of items) {
    const item = IMPORT_INTERNALS.prepareImportedEventItem(raw, sourceKey, sourceType, sourceName);
    if (!item || IMPORT_INTERNALS.shouldRejectEventItem(item)) continue;
    item.id = await IMPORT_INTERNALS.itemId(item);
    prepared.push(item);
  }

  log(`Prepared imported items: ${prepared.length}/${items.length}`);
  const nextItems = await IMPORT_INTERNALS.mergeImportedEventItems(existing, prepared);
  const meta = {
    lastScanAt: payload.syncedAt || new Date().toISOString(),
    reason: `import:${sourceKey}:${importMode}`,
    enabledSources: (sourceConfig.sources || []).filter((source) => source.enabled).length,
    collectedItems: reportedImportedCount,
    totalItems: nextItems.length,
    eventItems: nextItems.filter((item) => (item.categories?.includes("events") || item.eventDate) && IMPORT_INTERNALS.isAllowedEventItem(item, buildAllowedWindowEnv())).length,
    sources: IMPORT_INTERNALS.normalizeImportedMetaSources(payload.sourceStats, sourceKey, sourceName, importMode, reportedImportedCount)
  };

  await writeRemoteJson("events:items", nextItems);
  await writeRemoteJson("events:meta", meta);

  return {
    ok: true,
    source: sourceKey,
    mode: importMode,
    imported: prepared.length,
    totalItems: nextItems.length,
    meta
  };
}

async function readRemoteJson(key, fallback) {
  try {
    const { stdout } = await runWrangler([
      "kv",
      "key",
      "get",
      key,
      "--binding",
      "KAZAN_KV",
      "--remote",
      "--preview",
      "false",
      "--text",
      "--config",
      WRANGLER_CONFIG,
      "--env-file",
      WRANGLER_ENV_FILE
    ]);

    const raw = String(stdout || "").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    const message = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
    if (/no such key|not found/i.test(message)) {
      return fallback;
    }
    throw error;
  }
}

async function writeRemoteJson(key, value) {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const tempPath = path.join(TMP_DIR, `${key.replace(/[^a-z0-9_-]+/gi, "_")}.json`);
  await fs.writeFile(tempPath, JSON.stringify(value), "utf8");

  await runWrangler([
    "kv",
    "key",
    "put",
    key,
    "--path",
    tempPath,
    "--binding",
    "KAZAN_KV",
    "--remote",
    "--preview",
    "false",
    "--config",
    WRANGLER_CONFIG,
    "--env-file",
    WRANGLER_ENV_FILE
  ]);
}

async function runWrangler(args) {
  if (process.platform === "win32") {
    const commandLine = `npx wrangler ${args.map(quotePowerShellArg).join(" ")}`;
    return execFileAsync("powershell.exe", ["-NoProfile", "-Command", commandLine], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024
    });
  }

  return execFileAsync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024
  });
}

function buildAllowedWindowEnv() {
  return {
    EVENTS_ALLOWED_FROM: process.env.EVENTS_ALLOWED_FROM || "",
    EVENTS_ALLOWED_TO: process.env.EVENTS_ALLOWED_TO || ""
  };
}

function quotePowerShellArg(value) {
  const text = String(value || "");
  if (!/[\s'"`$]/u.test(text)) {
    return text;
  }

  return `'${text.replace(/'/g, "''")}'`;
}
