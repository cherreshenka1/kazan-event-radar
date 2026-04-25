import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const GALLERY_PATH = path.join(ROOT, "data", "catalog-moderation", "review-gallery.html");

if (!fs.existsSync(GALLERY_PATH)) {
  console.error([
    "Catalog moderation gallery was not found.",
    "Run this first:",
    "npm run catalog:moderation:candidates -- --max-images-per-item=1 --max-sources-per-item=2"
  ].join("\n"));
  process.exitCode = 1;
} else {
  openFile(GALLERY_PATH);
  console.log(`Opened: ${path.relative(ROOT, GALLERY_PATH)}`);
}

function openFile(filePath) {
  const command = process.platform === "win32"
    ? { bin: "powershell.exe", args: ["-NoProfile", "-Command", "Start-Process", "-LiteralPath", filePath] }
    : process.platform === "darwin"
      ? { bin: "open", args: [filePath] }
      : { bin: "xdg-open", args: [filePath] };

  const child = spawn(command.bin, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  child.unref();
}
