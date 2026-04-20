import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeRemoteJson } from "./lib/remote-kv-json.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REPORT_PATH = path.join(ROOT, "data", "playwright", "refresh-report.json");

const cliOptions = parseCliOptions(process.argv.slice(2));

await main().catch(async (error) => {
  await writeReport({
    ok: false,
    mode: cliOptions.mode,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    steps: [],
    error: error.message || String(error)
  }).catch(() => null);
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });

  const startedAt = Date.now();
  const steps = [];

  if (!cliOptions.skipAfisha) {
    steps.push(await runStep({
      id: "afisha",
      label: "Afisha browser refresh",
      script: path.join(ROOT, "scripts", "sync-browser-events.mjs"),
      args: buildAfishaArgs(cliOptions),
      snapshots: [
        path.join(ROOT, "data", "playwright", "yandex-browser-events.json"),
        path.join(ROOT, "data", "playwright", "mts-live-events.json"),
        path.join(ROOT, "data", "playwright", "kassir-browser-events.json")
      ]
    }));
  }

  if (!cliOptions.skipSports) {
    steps.push(await runStep({
      id: "sports",
      label: "Official sport refresh",
      script: path.join(ROOT, "scripts", "import-official-sport-events.mjs"),
      args: buildSportArgs(cliOptions),
      snapshots: [
        path.join(ROOT, "data", "playwright", "official-sport-events.json")
      ]
    }));
  }

  if (steps.length === 0) {
    throw new Error("No refresh steps selected. Remove --skip-afisha or --skip-sports.");
  }

  const finishedAt = Date.now();
  const ok = steps.every((step) => step.ok);
  const report = {
    ok,
    mode: cliOptions.mode,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    steps
  };

  report.kvSync = await syncReportToKv("system:eventsRefreshReport", report);
  await writeReport(report);
  console.log(`Refresh report: ${REPORT_PATH}`);

  if (!ok) {
    process.exitCode = 1;
  }
}

async function runStep(config) {
  const startedAt = Date.now();
  const command = [process.execPath, path.relative(ROOT, config.script), ...config.args].join(" ");

  console.log(`\n=== ${config.label} ===`);
  console.log(`Command: ${command}`);

  try {
    await runNodeScript(config.script, config.args);
    const finishedAt = Date.now();
    return {
      id: config.id,
      label: config.label,
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      command,
      snapshots: await readSnapshotSummaries(config.snapshots)
    };
  } catch (error) {
    const finishedAt = Date.now();
    return {
      id: config.id,
      label: config.label,
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      command,
      error: error.message || String(error),
      snapshots: await readSnapshotSummaries(config.snapshots)
    };
  }
}

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
      env: process.env
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Subprocess failed with exit code ${code}: ${path.basename(scriptPath)}`));
    });
  });
}

function buildAfishaArgs(options) {
  const args = [];

  if (options.mode === "full") {
    args.push("--all");
  } else {
    args.push("--incremental");
  }

  if (options.noUpload) args.push("--no-upload");
  if (options.headless) args.push("--headless");
  if (options.kassirHeadless) args.push("--kassir-headless");
  if (options.withKassir && !options.skipKassir) args.push("--with-kassir");
  if (options.skipKassir) args.push("--skip-kassir");
  if (options.maxLinks != null) args.push(`--max-links=${options.maxLinks}`);
  if (options.maxSources != null) args.push(`--max-sources=${options.maxSources}`);
  if (options.chunkSize != null) args.push(`--chunk-size=${options.chunkSize}`);
  if (options.pauseMs != null) args.push(`--pause-ms=${options.pauseMs}`);
  if (options.retries != null) args.push(`--retries=${options.retries}`);

  return args;
}

function buildSportArgs(options) {
  const args = [];
  if (options.noUpload) args.push("--no-upload");
  return args;
}

async function readSnapshotSummaries(filePaths = []) {
  const summaries = [];

  for (const filePath of filePaths) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const payload = JSON.parse(raw);
      summaries.push({
        file: path.relative(ROOT, filePath),
        source: payload?.source || "",
        syncedAt: payload?.syncedAt || null,
        items: Array.isArray(payload?.items) ? payload.items.length : 0,
        reportedImportedCount: Number(payload?.reportedImportedCount || 0),
        sources: Array.isArray(payload?.sourceStats)
          ? payload.sourceStats.map((source) => ({
            id: source.id,
            importedItems: Number(source.importedItems || 0),
            collectedLinks: Number(source.collectedLinks || 0),
            queuedLinks: Number(source.queuedLinks || 0)
          }))
          : []
      });
    } catch {
      summaries.push({
        file: path.relative(ROOT, filePath),
        missing: true
      });
    }
  }

  return summaries;
}

async function writeReport(report) {
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function syncReportToKv(key, report) {
  try {
    await writeRemoteJson(key, report);
    return {
      ok: true,
      key,
      syncedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      key,
      syncedAt: null,
      error: error.message || String(error)
    };
  }
}

function parseCliOptions(args) {
  const options = {
    mode: "incremental",
    noUpload: false,
    skipAfisha: false,
    skipSports: false,
    withKassir: false,
    skipKassir: false,
    headless: false,
    kassirHeadless: false,
    maxLinks: null,
    maxSources: null,
    chunkSize: null,
    pauseMs: null,
    retries: null
  };

  for (const arg of args) {
    if (arg === "--full" || arg === "--all") {
      options.mode = "full";
      continue;
    }

    if (arg === "--incremental") {
      options.mode = "incremental";
      continue;
    }

    if (arg === "--no-upload") {
      options.noUpload = true;
      continue;
    }

    if (arg === "--skip-afisha") {
      options.skipAfisha = true;
      continue;
    }

    if (arg === "--skip-sports") {
      options.skipSports = true;
      continue;
    }

    if (arg === "--with-kassir") {
      options.withKassir = true;
      continue;
    }

    if (arg === "--skip-kassir") {
      options.skipKassir = true;
      continue;
    }

    if (arg === "--headless") {
      options.headless = true;
      continue;
    }

    if (arg === "--kassir-headless") {
      options.kassirHeadless = true;
      continue;
    }

    if (arg.startsWith("--max-links=")) {
      options.maxLinks = Number(arg.slice("--max-links=".length));
      continue;
    }

    if (arg.startsWith("--max-sources=")) {
      options.maxSources = Number(arg.slice("--max-sources=".length));
      continue;
    }

    if (arg.startsWith("--chunk-size=")) {
      options.chunkSize = Number(arg.slice("--chunk-size=".length));
      continue;
    }

    if (arg.startsWith("--pause-ms=")) {
      options.pauseMs = Number(arg.slice("--pause-ms=".length));
      continue;
    }

    if (arg.startsWith("--retries=")) {
      options.retries = Number(arg.slice("--retries=".length));
    }
  }

  if (!options.withKassir) {
    options.skipKassir = true;
  }

  return options;
}
