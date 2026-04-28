import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const FORBIDDEN_TRACKED_PATHS = [
  /^\.env$/u,
  /^\.cloudflare\.env$/u,
  /^config\/catalog-moderation-approvals\.json$/u,
  /^data\/playwright\/.*(?:state|auth).*\.json$/iu,
  /^data\/playwright\/.*\.bin$/iu
];

const SECRET_PATTERNS = [
  {
    id: "telegram_bot_token",
    pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/u
  }
];
const SENSITIVE_ASSIGNMENT_KEYS = new Set([
  "CLOUDFLARE_API_TOKEN",
  "AUTOMATION_TOKEN",
  "WORKER_AUTOMATION_TOKEN",
  "ANALYTICS_PASSWORD",
  "TELEGRAM_BOT_TOKEN",
  "INSTAGRAM_ACCESS_TOKEN",
  "TIKTOK_ACCESS_TOKEN"
]);

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const trackedFiles = gitLsFiles();
  const issues = [];

  for (const file of trackedFiles) {
    const normalized = file.replaceAll("\\", "/");
    if (FORBIDDEN_TRACKED_PATHS.some((pattern) => pattern.test(normalized))) {
      issues.push({
        type: "forbidden_tracked_file",
        file: normalized,
        detail: "Local secrets or browser auth state must not be tracked by Git."
      });
      continue;
    }

    if (!isTextFile(normalized)) continue;

    const content = await safeReadText(path.join(ROOT, normalized));
    if (!content) continue;

    for (const check of SECRET_PATTERNS) {
      if (check.pattern.test(content)) {
        issues.push({
          type: check.id,
          file: normalized,
          detail: "Possible secret value found in a tracked file."
        });
      }
    }

    for (const assignment of findSensitiveAssignments(content, normalized)) {
      issues.push({
        type: "sensitive_assignment",
        file: normalized,
        detail: `Possible real value for ${assignment.key} on line ${assignment.lineNumber}.`
      });
    }
  }

  if (issues.length) {
    console.error("Security audit failed:");
    for (const issue of issues) {
      console.error(`- ${issue.type}: ${issue.file} - ${issue.detail}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Security audit passed for ${trackedFiles.length} tracked files.`);
}

function gitLsFiles() {
  const result = spawnSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function findSensitiveAssignments(content, filePath = "") {
  const issues = [];
  const lines = String(content || "").split(/\r?\n/u);

  lines.forEach((line, index) => {
    const match = line.match(/\b([A-Z0-9_]*(?:TOKEN|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*["']?([^"'\s#]+)/iu);
    if (!match) return;

    const key = match[1].toUpperCase();
    const value = match[2].trim();
    if (!SENSITIVE_ASSIGNMENT_KEYS.has(key)) return;
    if (isSafeExampleSecretValue(value, line, filePath)) return;

    issues.push({
      key,
      lineNumber: index + 1
    });
  });

  return issues;
}

function isSafeExampleSecretValue(value, line = "", filePath = "") {
  const normalized = String(value || "").trim();
  const sourceLine = String(line || "");
  if (!normalized) return true;
  if (sourceLine.includes("${{ secrets.") || sourceLine.includes("%s")) return true;
  if (normalized.startsWith("$") || normalized.includes("${{")) return true;
  if (/^(example|placeholder|changeme|null|false|true|strong-password|random-private-salt)$/iu.test(normalized)) return true;
  if (/^(put_your_|your_|set_|todo|xxx|<)/iu.test(normalized)) return true;
  if (filePath.endsWith(".md") && /(?:example|пример|your-|strong-|random-|put_your_|```)/iu.test(sourceLine)) return true;
  if (normalized.length < 12) return true;
  return false;
}

function isTextFile(file) {
  return [
    ".js",
    ".mjs",
    ".json",
    ".md",
    ".txt",
    ".yml",
    ".yaml",
    ".toml",
    ".example",
    ".ps1",
    ".html",
    ".css"
  ].includes(path.extname(file).toLowerCase()) || file.endsWith(".env.example");
}

async function safeReadText(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 2_000_000) return "";
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
