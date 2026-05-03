import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const TMP_DIR = path.join(ROOT, "data", "playwright", ".tmp");
const WRANGLER_CONFIG = path.join(ROOT, "worker", "wrangler.toml");
const WRANGLER_ENV_FILE = path.join(ROOT, ".cloudflare.env");
const execFileAsync = promisify(execFile);

export async function writeRemoteJson(key, value) {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const tempPath = path.join(TMP_DIR, `${String(key).replace(/[^a-z0-9_-]+/gi, "_")}.json`);
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
    ...await resolveEnvFileArgs()
  ]);
}

export async function readRemoteJson(key, fallback = null) {
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
      "--config",
      WRANGLER_CONFIG,
      ...await resolveEnvFileArgs()
    ]);
    return stdout ? JSON.parse(stdout) : fallback;
  } catch {
    return fallback;
  }
}

async function resolveEnvFileArgs() {
  try {
    await fs.access(WRANGLER_ENV_FILE);
    return ["--env-file", WRANGLER_ENV_FILE];
  } catch {
    return [];
  }
}

async function runWrangler(args) {
  if (process.platform === "win32") {
    const commandLine = `npx wrangler ${args.map(quotePowerShellArg).join(" ")}`;
    return execFileAsync("powershell.exe", ["-NoProfile", "-Command", commandLine], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      env: process.env
    });
  }

  return execFileAsync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env
  });
}

function quotePowerShellArg(value) {
  const text = String(value || "");
  if (!/[\s'"`$]/u.test(text)) {
    return text;
  }

  return `'${text.replace(/'/g, "''")}'`;
}
