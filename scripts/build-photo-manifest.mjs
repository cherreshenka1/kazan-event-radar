import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PHOTOS_ROOT = path.join(ROOT, "public", "miniapp", "photos");
const OUTPUT_PATH = path.join(ROOT, "public", "miniapp", "photo-manifest.js");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const manifest = await buildManifest();
  const output = `window.KAZAN_EVENT_RADAR_PHOTO_MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`;
  await fs.writeFile(OUTPUT_PATH, output, "utf8");
  console.log(`Photo manifest updated: ${path.relative(ROOT, OUTPUT_PATH)}`);
}

async function buildManifest() {
  const manifest = {};
  const sectionEntries = await safeReadDir(PHOTOS_ROOT);

  for (const sectionEntry of sectionEntries) {
    if (!sectionEntry.isDirectory()) continue;

    const sectionId = sectionEntry.name;
    const sectionPath = path.join(PHOTOS_ROOT, sectionId);
    const itemEntries = await safeReadDir(sectionPath);
    const sectionItems = {};

    for (const itemEntry of itemEntries) {
      if (!itemEntry.isDirectory()) continue;

      const itemId = itemEntry.name;
      const itemPath = path.join(sectionPath, itemId);
      const fileEntries = await safeReadDir(itemPath);
      const files = fileEntries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((fileName) => IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
        .sort((left, right) => left.localeCompare(right, "ru", { numeric: true, sensitivity: "base" }));

      if (!files.length) continue;

      sectionItems[itemId] = files.map((fileName, index) => ({
        label: `Фото ${index + 1}`,
        url: `./photos/${sectionId}/${itemId}/${fileName}`
      }));
    }

    if (Object.keys(sectionItems).length) {
      manifest[sectionId] = sectionItems;
    }
  }

  return manifest;
}

async function safeReadDir(targetPath) {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }
}
