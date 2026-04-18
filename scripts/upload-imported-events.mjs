import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMiniAppApiBaseUrl, uploadImportedPayloadInChunks } from "./lib/upload-imported-payload.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const MINI_APP_CONFIG_PATH = path.join(ROOT, "public", "miniapp", "config.js");

const cliOptions = parseCliOptions(process.argv.slice(2));

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  if (!cliOptions.filePath) {
    throw new Error("Pass --file=path/to/import.json");
  }

  const filePath = path.resolve(ROOT, cliOptions.filePath);
  const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  const allItems = Array.isArray(payload.items) ? payload.items : [];
  const startIndex = Math.max(0, Number(cliOptions.startIndex) || 0);
  const endIndex = cliOptions.endIndex == null ? allItems.length : Math.min(allItems.length, Number(cliOptions.endIndex) || allItems.length);
  const items = allItems.slice(startIndex, endIndex);

  if (!items.length) {
    console.log("Nothing to upload: payload.items is empty.");
    return;
  }

  const apiBaseUrl = (process.env.WORKER_API_BASE_URL || await readMiniAppApiBaseUrl(MINI_APP_CONFIG_PATH)).replace(/\/$/, "");
  if (!apiBaseUrl) {
    throw new Error("WORKER_API_BASE_URL is not configured.");
  }

  const chunkSize = Math.max(1, Number(cliOptions.chunkSize) || 5);
  const pauseMs = Math.max(0, Number(cliOptions.pauseMs) || 600);
  const source = cliOptions.source || payload.source || "browser_import";
  const mode = cliOptions.mode || payload.mode || "merge";
  const syncedAt = payload.syncedAt || new Date().toISOString();
  const runMode = payload.runMode || "manual";
  const sourceStats = Array.isArray(payload.sourceStats) ? payload.sourceStats : [];
  const reportedImportedCount = Math.max(0, Number(payload.reportedImportedCount || items.length));

  console.log(`Uploading ${items.length} items from ${path.relative(ROOT, filePath)} to ${apiBaseUrl}`);
  console.log(`Slice: ${startIndex}..${endIndex}`);
  console.log(`Source: ${source}, mode: ${mode}, chunk size: ${chunkSize}`);

  const result = await uploadImportedPayloadInChunks(apiBaseUrl, {
    source,
    mode,
    syncedAt,
    runMode,
    sourceStats,
    reportedImportedCount,
    items
  }, {
    chunkSize,
    pauseMs,
    retries: cliOptions.retries,
    continueOnError: cliOptions.continueOnError,
    log: console.log
  });

  console.log(`Upload finished: ${result.imported || 0} items sent.`);
  if ((result.failed || []).length) {
    console.log(`Failed items: ${result.failed.length}`);
  }
}

function parseCliOptions(args) {
  const options = {
    filePath: "",
    source: "",
    mode: "",
    chunkSize: 5,
    pauseMs: 600,
    retries: 5,
    startIndex: 0,
    endIndex: null,
    continueOnError: true
  };

  for (const arg of args) {
    if (arg.startsWith("--file=")) {
      options.filePath = arg.slice("--file=".length);
      continue;
    }

    if (arg.startsWith("--source=")) {
      options.source = arg.slice("--source=".length);
      continue;
    }

    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg.startsWith("--chunk-size=")) {
      options.chunkSize = Number(arg.slice("--chunk-size=".length)) || 5;
      continue;
    }

    if (arg.startsWith("--pause-ms=")) {
      options.pauseMs = Number(arg.slice("--pause-ms=".length)) || 0;
      continue;
    }

    if (arg.startsWith("--retries=")) {
      options.retries = Number(arg.slice("--retries=".length)) || 5;
      continue;
    }

    if (arg.startsWith("--start-index=")) {
      options.startIndex = Number(arg.slice("--start-index=".length)) || 0;
      continue;
    }

    if (arg.startsWith("--end-index=")) {
      options.endIndex = Number(arg.slice("--end-index=".length)) || null;
      continue;
    }

    if (arg === "--stop-on-error") {
      options.continueOnError = false;
    }
  }

  return options;
}
