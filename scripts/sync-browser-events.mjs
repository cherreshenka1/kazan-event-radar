import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const cliOptions = parseCliOptions(process.argv.slice(2));

async function main() {
  const tasks = [];

  if (!cliOptions.skipYandex) {
    tasks.push({
      key: "yandex",
      label: "Yandex Afisha",
      script: path.join(ROOT, "scripts", "sync-yandex-browser-events.mjs")
    });
  }

  if (!cliOptions.skipMts) {
    tasks.push({
      key: "mts",
      label: "MTS Live",
      script: path.join(ROOT, "scripts", "import-mts-live-events.mjs")
    });
  }

  if (cliOptions.withKassir && !cliOptions.skipKassir) {
    tasks.push({
      key: "kassir",
      label: "Kassir",
      script: path.join(ROOT, "scripts", "sync-kassir-browser-events.mjs")
    });
  }

  if (!tasks.length) {
    throw new Error("No sync targets were selected. Remove --skip-yandex / --skip-mts.");
  }

  for (const task of tasks) {
    console.log(`\n=== ${task.label} ===`);
    await runNodeScript(task.script, buildChildArgs(cliOptions, task.key));
  }

  console.log("\nBrowser afisha sync completed.");
}

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      stdio: "inherit",
      shell: false
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

function buildChildArgs(options, taskKey = "") {
  const args = [];

  if (options.all) args.push("--all");
  if (options.incremental) args.push("--incremental");
  if (options.reconcile) args.push("--reconcile");
  if (options.noUpload) args.push("--no-upload");
  if (options.headless && shouldRunTaskHeadless(taskKey, options)) args.push("--headless");
  if (options.maxLinks != null) args.push(`--max-links=${options.maxLinks}`);
  if (options.maxSources != null) args.push(`--max-sources=${options.maxSources}`);
  if (options.chunkSize != null) args.push(`--chunk-size=${options.chunkSize}`);
  if (options.pauseMs != null) args.push(`--pause-ms=${options.pauseMs}`);
  if (options.retries != null) args.push(`--retries=${options.retries}`);

  return args;
}

function parseCliOptions(args) {
  const options = {
    all: false,
    incremental: false,
    reconcile: false,
    noUpload: false,
    headless: false,
    maxLinks: null,
    maxSources: null,
    chunkSize: null,
    pauseMs: null,
    retries: null,
    kassirHeaded: true,
    skipYandex: false,
    skipMts: false,
    withKassir: false,
    skipKassir: false
  };

  for (const arg of args) {
    if (arg === "--all") {
      options.all = true;
      continue;
    }

    if (arg === "--incremental") {
      options.incremental = true;
      continue;
    }

    if (arg === "--reconcile") {
      options.reconcile = true;
      continue;
    }

    if (arg === "--no-upload") {
      options.noUpload = true;
      continue;
    }

    if (arg === "--headless") {
      options.headless = true;
      continue;
    }

    if (arg === "--kassir-headless") {
      options.kassirHeaded = false;
      continue;
    }

    if (arg === "--skip-yandex") {
      options.skipYandex = true;
      continue;
    }

    if (arg === "--skip-mts") {
      options.skipMts = true;
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

    if (arg.startsWith("--max-links=")) {
      options.maxLinks = Number(arg.slice("--max-links=".length)) || null;
      continue;
    }

    if (arg.startsWith("--max-sources=")) {
      options.maxSources = Number(arg.slice("--max-sources=".length)) || null;
      continue;
    }

    if (arg.startsWith("--chunk-size=")) {
      options.chunkSize = Number(arg.slice("--chunk-size=".length)) || null;
      continue;
    }

    if (arg.startsWith("--pause-ms=")) {
      options.pauseMs = Number(arg.slice("--pause-ms=".length)) || null;
      continue;
    }

    if (arg.startsWith("--retries=")) {
      options.retries = Number(arg.slice("--retries=".length)) || null;
    }
  }

  return options;
}

function shouldRunTaskHeadless(taskKey, options) {
  if (taskKey !== "kassir") {
    return true;
  }

  return !options.kassirHeaded;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
