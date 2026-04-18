import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeImportedPayloadToKv } from "./lib/import-payload-to-kv.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

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
  const endIndex = cliOptions.endIndex == null
    ? allItems.length
    : Math.min(allItems.length, Number(cliOptions.endIndex) || allItems.length);
  const items = allItems.slice(startIndex, endIndex);

  console.log(`Uploading via KV: ${items.length} items from ${path.relative(ROOT, filePath)}`);
  console.log(`Slice: ${startIndex}..${endIndex}`);

  const result = await mergeImportedPayloadToKv({
    ...payload,
    source: cliOptions.source || payload.source || "browser_import",
    mode: cliOptions.mode || payload.mode || "merge",
    syncedAt: payload.syncedAt || new Date().toISOString(),
    runMode: payload.runMode || "manual",
    sourceStats: Array.isArray(payload.sourceStats) ? payload.sourceStats : [],
    reportedImportedCount: Math.max(0, Number(payload.reportedImportedCount || items.length)),
    items
  }, {
    log: console.log
  });

  console.log(JSON.stringify({
    ok: result.ok,
    source: result.source,
    mode: result.mode,
    imported: result.imported,
    totalItems: result.totalItems,
    syncedAt: result.meta?.lastScanAt || null
  }, null, 2));
}

function parseCliOptions(args) {
  const options = {
    filePath: "",
    source: "",
    mode: "",
    startIndex: 0,
    endIndex: null
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

    if (arg.startsWith("--start-index=")) {
      options.startIndex = Number(arg.slice("--start-index=".length)) || 0;
      continue;
    }

    if (arg.startsWith("--end-index=")) {
      options.endIndex = Number(arg.slice("--end-index=".length)) || null;
    }
  }

  return options;
}
