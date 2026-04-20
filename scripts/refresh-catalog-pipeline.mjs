import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REPORT_PATH = path.join(ROOT, "data", "catalog-imports", "refresh-report.json");
const GENERATED_OVERRIDES_PATH = path.join(ROOT, "src", "data", "catalog-imports.generated.js");

const cliOptions = parseCliOptions(process.argv.slice(2));

await main().catch(async (error) => {
  await writeReport({
    ok: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    deployRequested: cliOptions.deploy,
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

  steps.push(await runCommandStep({
    id: "catalog-refresh",
    label: "Catalog import refresh",
    command: resolveNpmCommand(cliOptions.staleOnly ? "catalog:refresh:stale" : "catalog:refresh")
  }));

  steps.push(await runCommandStep({
    id: "syntax-check",
    label: "Project syntax check",
    command: resolveNpmCommand("check")
  }));

  if (cliOptions.deploy) {
    steps.push(await runCommandStep({
      id: "worker-deploy",
      label: "Worker deploy",
      command: resolveNpmCommand("worker:deploy")
    }));
  }

  const finishedAt = Date.now();
  const ok = steps.every((step) => step.ok);
  const report = {
    ok,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    deployRequested: cliOptions.deploy,
    staleOnly: cliOptions.staleOnly,
    steps,
    sections: await readCatalogSectionSummaries(),
    generatedOverrides: await readGeneratedOverridesSummary()
  };

  await writeReport(report);
  console.log(`Catalog refresh report: ${REPORT_PATH}`);

  if (!ok) {
    process.exitCode = 1;
  }
}

async function runCommandStep(config) {
  const startedAt = Date.now();
  console.log(`\n=== ${config.label} ===`);
  console.log(`Command: ${config.command.display}`);

  try {
    await runCommand(config.command);
    const finishedAt = Date.now();
    return {
      id: config.id,
      label: config.label,
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      command: config.command.display
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
      command: config.command.display,
      error: error.message || String(error)
    };
  }
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
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

      reject(new Error(`Command failed with exit code ${code}: ${command.display}`));
    });
  });
}

function resolveNpmCommand(scriptName) {
  if (process.platform === "win32") {
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", `npm run ${scriptName}`],
      display: `npm run ${scriptName}`
    };
  }

  return {
    bin: "npm",
    args: ["run", scriptName],
    display: `npm run ${scriptName}`
  };
}

async function readCatalogSectionSummaries() {
  const normalizedDir = path.join(ROOT, "data", "catalog-imports", "normalized");

  try {
    const entries = await fs.readdir(normalizedDir, { withFileTypes: true });
    const summaries = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      const filePath = path.join(normalizedDir, entry.name);
      const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
      summaries.push({
        section: payload.section || entry.name.replace(/\.json$/i, ""),
        file: path.relative(ROOT, filePath),
        title: payload.title || "",
        itemCount: Array.isArray(payload.items) ? payload.items.length : Number(payload.itemCount || 0),
        generatedAt: payload.generatedAt || null
      });
    }

    return summaries.sort((a, b) => a.section.localeCompare(b.section, "ru"));
  } catch {
    return [];
  }
}

async function readGeneratedOverridesSummary() {
  try {
    const contents = await fs.readFile(GENERATED_OVERRIDES_PATH, "utf8");
    const match = contents.match(/export const CATALOG_IMPORT_OVERRIDES = (\{[\s\S]*\});/u);
    if (!match) {
      return {
        file: path.relative(ROOT, GENERATED_OVERRIDES_PATH),
        exists: true,
        sectionCount: 0
      };
    }

    const overrides = JSON.parse(match[1]);
    return {
      file: path.relative(ROOT, GENERATED_OVERRIDES_PATH),
      exists: true,
      sectionCount: Object.keys(overrides || {}).length
    };
  } catch {
    return {
      file: path.relative(ROOT, GENERATED_OVERRIDES_PATH),
      exists: false,
      sectionCount: 0
    };
  }
}

async function writeReport(report) {
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function parseCliOptions(args) {
  const options = {
    deploy: true,
    staleOnly: false
  };

  for (const arg of args) {
    if (arg === "--deploy") {
      options.deploy = true;
      continue;
    }

    if (arg === "--no-deploy") {
      options.deploy = false;
      continue;
    }

    if (arg === "--stale-only") {
      options.staleOnly = true;
      continue;
    }

    if (arg === "--all") {
      options.staleOnly = false;
    }
  }

  return options;
}
