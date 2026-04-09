import fs from "node:fs";
import path from "node:path";

const workerUrl = process.argv[2];

if (!workerUrl) {
  console.error("Usage: node worker/scripts/set-miniapp-api.js https://your-worker.workers.dev");
  process.exit(1);
}

const configPath = path.resolve(process.cwd(), "public", "miniapp", "config.js");
const normalizedUrl = workerUrl.replace(/\/$/, "");
const content = `window.KAZAN_EVENT_RADAR_CONFIG = {\n  apiBaseUrl: "${normalizedUrl}"\n};\n`;

fs.writeFileSync(configPath, content, "utf8");
console.log(`Mini App API base URL saved to ${configPath}`);
