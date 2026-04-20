import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const TARGET_DIRS = ["src", "public", "worker", "scripts"];
const TARGET_EXTENSIONS = new Set([".js", ".mjs"]);

const files = [];

for (const targetDir of TARGET_DIRS) {
  await collectFiles(path.join(ROOT, targetDir), files);
}

for (const filePath of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log(`Syntax check passed for ${files.length} files.`);

async function collectFiles(currentPath, output) {
  let entries = [];

  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(fullPath, output);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!TARGET_EXTENSIONS.has(path.extname(entry.name))) continue;

    output.push(fullPath);
  }
}
