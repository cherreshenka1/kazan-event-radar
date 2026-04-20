import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import catalogSources from "../config/catalog-sources.json" with { type: "json" };

const cliOptions = parseCliOptions(process.argv.slice(2));

const sectionTasks = [
  { sectionId: "sights", script: "catalog:sights" },
  { sectionId: "parks", script: "catalog:parks" },
  { sectionId: "food", script: "catalog:food" },
  { sectionId: "hotels", script: "catalog:hotels" },
  { sectionId: "excursions", script: "catalog:excursions" },
  { sectionId: "routes", script: "catalog:routes" },
  { sectionId: "active", script: "catalog:active" },
  { sectionId: "roadtrip", script: "catalog:roadtrip" }
];

const scripts = resolveScriptsToRun();

for (const script of scripts) {
  console.log(`\n=== Running ${script} ===`);

  const command = process.platform === "win32"
    ? { bin: "cmd.exe", args: ["/d", "/s", "/c", `npm run ${script}`] }
    : { bin: "npm", args: ["run", script] };

  const result = spawnSync(command.bin, command.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log("\nCatalog refresh completed.");

function resolveScriptsToRun() {
  const selectedSectionTasks = cliOptions.staleOnly
    ? sectionTasks.filter((task) => shouldRefreshSection(task.sectionId))
    : sectionTasks;

  if (cliOptions.staleOnly) {
    if (selectedSectionTasks.length) {
      console.log(`Running stale catalog sections: ${selectedSectionTasks.map((task) => task.sectionId).join(", ")}`);
    } else {
      console.log("No catalog sections require refresh by refreshDays. Running validation only.");
    }
  }

  return [
    ...selectedSectionTasks.map((task) => task.script),
    "catalog:sources"
  ];
}

function shouldRefreshSection(sectionId) {
  const sectionConfig = catalogSources.sections?.[sectionId];
  const refreshDays = Math.max(1, Number(sectionConfig?.refreshDays || 1));
  const normalizedPath = path.join(process.cwd(), "data", "catalog-imports", "normalized", `${sectionId}.json`);

  if (!fs.existsSync(normalizedPath)) {
    return true;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    const generatedAt = payload?.generatedAt ? new Date(payload.generatedAt) : null;
    if (!generatedAt || Number.isNaN(generatedAt.getTime())) {
      return true;
    }

    const elapsedMs = Date.now() - generatedAt.getTime();
    return elapsedMs >= refreshDays * 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

function parseCliOptions(args) {
  const options = {
    staleOnly: false
  };

  for (const arg of args) {
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
