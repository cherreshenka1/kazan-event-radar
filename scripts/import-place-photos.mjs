import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_CATALOG } from "../src/data/catalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PHOTOS_ROOT = path.join(ROOT, "public", "miniapp", "photos");
const REPORT_PATH = path.join(ROOT, "data", "catalog-imports", "place-photo-import-report.json");
const MANIFEST_PATH = path.join(ROOT, "public", "miniapp", "photo-manifest.js");
const PLACE_SECTIONS = ["parks", "sights", "hotels", "excursions"];
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const IMAGE_EXTENSIONS_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};
const USER_AGENT = "KazanEventRadar/1.0 place-photo-import (https://github.com/cherreshenka1/kazan-event-radar)";

const options = parseOptions(process.argv.slice(2));

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const sections = options.sections.length ? options.sections : PLACE_SECTIONS;
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.dryRun ? "dry_run" : "import",
    sections: [],
    totals: {
      items: 0,
      skippedWithPhotos: 0,
      importedPhotos: 0,
      missingCandidates: 0
    }
  };

  for (const sectionId of sections) {
    const section = BASE_CATALOG[sectionId];
    if (!Array.isArray(section?.items)) continue;

    const items = options.limitPerSection ? section.items.slice(0, options.limitPerSection) : section.items;
    const sectionReport = {
      sectionId,
      title: section.title || sectionId,
      items: []
    };

    for (const item of items) {
      const itemReport = await importItemPhotos(sectionId, item);
      sectionReport.items.push(itemReport);
      report.totals.items += 1;
      report.totals.importedPhotos += itemReport.imported.length;
      if (itemReport.skippedReason === "already_has_photos") report.totals.skippedWithPhotos += 1;
      if (!itemReport.candidates.length && !itemReport.skippedReason) report.totals.missingCandidates += 1;
    }

    report.sections.push(sectionReport);
  }

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!options.dryRun && report.totals.importedPhotos > 0) {
    await writePhotoManifest();
  }

  console.log(`Place photo import: ${report.totals.importedPhotos} photos imported for ${report.totals.items} cards.`);
  console.log(`Skipped with photos: ${report.totals.skippedWithPhotos}`);
  console.log(`Missing candidates: ${report.totals.missingCandidates}`);
  console.log(`Report: ${path.relative(ROOT, REPORT_PATH)}`);
  if (!options.dryRun && report.totals.importedPhotos > 0) {
    console.log(`Photo manifest updated: ${path.relative(ROOT, MANIFEST_PATH)}`);
  }
}

async function importItemPhotos(sectionId, item) {
  const folder = path.join(PHOTOS_ROOT, sectionId, item.id);
  const existing = await readImageFiles(folder);
  const queries = buildSearchQueries(sectionId, item);
  const itemReport = {
    sectionId,
    id: item.id,
    title: item.title || item.id,
    queries,
    skippedReason: "",
    imported: [],
    candidates: []
  };

  if (existing.length && !options.force) {
    itemReport.skippedReason = "already_has_photos";
    return itemReport;
  }

  const candidates = await findCommonsCandidates(queries);
  itemReport.candidates = candidates.map((candidate) => ({
    title: candidate.title,
    url: candidate.url,
    license: candidate.licenseShortName || "",
    artist: stripHtml(candidate.artist || "")
  }));

  if (options.dryRun) return itemReport;

  await fs.mkdir(folder, { recursive: true });
  const attribution = [];
  let index = existing.length + 1;

  for (const candidate of candidates.slice(0, options.maxImagesPerItem)) {
    const imported = await downloadCommonsImage(folder, index, candidate);
    if (!imported) continue;
    itemReport.imported.push(imported);
    attribution.push({
      fileName: imported.fileName,
      sourceTitle: candidate.title,
      sourceUrl: candidate.descriptionUrl || candidate.url,
      artist: stripHtml(candidate.artist || ""),
      license: stripHtml(candidate.licenseShortName || candidate.license || ""),
      licenseUrl: candidate.licenseUrl || ""
    });
    index += 1;
  }

  if (attribution.length) {
    await writeAttribution(folder, attribution);
  }

  return itemReport;
}

async function findCommonsCandidates(queries) {
  const results = [];
  const seen = new Set();

  for (const query of queries) {
    const pages = await commonsSearch(query);
    for (const page of pages) {
      const image = normalizeCommonsImage(page);
      if (!image || seen.has(image.url)) continue;
      seen.add(image.url);
      results.push(image);
    }
  }

  return results
    .filter((item) => !isBadImageTitle(item.title))
    .sort((left, right) => imageScore(right) - imageScore(left))
    .slice(0, options.maxImagesPerItem * 3);
}

async function commonsSearch(query) {
  try {
    const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
    apiUrl.searchParams.set("action", "query");
    apiUrl.searchParams.set("format", "json");
    apiUrl.searchParams.set("generator", "search");
    apiUrl.searchParams.set("gsrnamespace", "6");
    apiUrl.searchParams.set("gsrlimit", String(options.searchLimit));
    apiUrl.searchParams.set("gsrsearch", query);
    apiUrl.searchParams.set("prop", "imageinfo");
    apiUrl.searchParams.set("iiprop", "url|mime|size|extmetadata");
    apiUrl.searchParams.set("iiurlwidth", "1400");

    const response = await fetch(apiUrl, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json"
      }
    });
    if (!response.ok) return [];

    const payload = await response.json();
    return Object.values(payload?.query?.pages || {});
  } catch {
    return [];
  }
}

function normalizeCommonsImage(page) {
  const info = page?.imageinfo?.[0];
  if (!info?.url || !IMAGE_EXTENSIONS_BY_MIME[String(info.mime || "").toLowerCase()]) return null;
  if (Number(info.size || 0) < 8000 || Number(info.size || 0) > options.maxImageBytes) return null;

  const metadata = info.extmetadata || {};
  return {
    title: page.title || "",
    url: info.thumburl || info.url,
    originalUrl: info.url,
    descriptionUrl: info.descriptionurl || "",
    mime: info.mime || "",
    size: Number(info.size || 0),
    width: Number(info.thumbwidth || info.width || 0),
    height: Number(info.thumbheight || info.height || 0),
    artist: metadata.Artist?.value || "",
    license: metadata.License?.value || "",
    licenseShortName: metadata.LicenseShortName?.value || "",
    licenseUrl: metadata.LicenseUrl?.value || ""
  };
}

async function downloadCommonsImage(folder, index, candidate) {
  try {
    const response = await fetch(candidate.url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        "user-agent": USER_AGENT,
        accept: "image/webp,image/png,image/jpeg,image/*;q=0.8"
      }
    });
    if (!response.ok) return null;

    const contentType = String(response.headers.get("content-type") || candidate.mime || "").split(";")[0].toLowerCase();
    const extension = IMAGE_EXTENSIONS_BY_MIME[contentType] || ".jpg";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 8000 || bytes.byteLength > options.maxImageBytes) return null;

    const fileName = `${String(index).padStart(2, "0")}${extension}`;
    const outputPath = path.join(folder, fileName);
    await fs.writeFile(outputPath, bytes);

    return {
      fileName,
      file: path.relative(ROOT, outputPath).replaceAll("\\", "/"),
      bytes: bytes.byteLength,
      sourceUrl: candidate.descriptionUrl || candidate.url
    };
  } catch {
    return null;
  }
}

async function writeAttribution(folder, entries) {
  const attributionPath = path.join(folder, "ATTRIBUTION.json");
  let current = [];
  try {
    const payload = JSON.parse(await fs.readFile(attributionPath, "utf8"));
    current = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  } catch {
    current = [];
  }

  const merged = [...current];
  const seen = new Set(current.map((item) => item.fileName));
  for (const entry of entries) {
    if (seen.has(entry.fileName)) continue;
    seen.add(entry.fileName);
    merged.push(entry);
  }

  await fs.writeFile(attributionPath, `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: "Wikimedia Commons",
    note: "Open-license image metadata. Keep attribution when reusing outside the Mini App.",
    items: merged
  }, null, 2)}\n`, "utf8");
}

async function writePhotoManifest() {
  const manifest = {};
  const sectionEntries = await readDirectories(PHOTOS_ROOT);

  for (const sectionEntry of sectionEntries) {
    const sectionId = sectionEntry.name;
    const itemEntries = await readDirectories(path.join(PHOTOS_ROOT, sectionId));
    const sectionItems = {};

    for (const itemEntry of itemEntries) {
      const itemId = itemEntry.name;
      const files = (await readImageFiles(path.join(PHOTOS_ROOT, sectionId, itemId)))
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

  await fs.writeFile(MANIFEST_PATH, `window.KAZAN_EVENT_RADAR_PHOTO_MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`, "utf8");
}

async function readImageFiles(folder) {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((fileName) => IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase()));
  } catch {
    return [];
  }
}

async function readDirectories(targetPath) {
  try {
    return (await fs.readdir(targetPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function buildSearchQueries(sectionId, item) {
  const title = cleanSearchText(item.title || item.subtitle || item.id);
  const overrides = {
    parks: {
      black_lake: ["Black Lake Park Kazan", "Парк Черное озеро Казань"],
      gorky: ["Gorky Park Kazan", "Парк Горького Казань"],
      uritsky: ["Uritsky Park Kazan", "Парк Урицкого Казань"],
      victory: ["Victory Park Kazan", "Парк Победы Казань"],
      millennium: ["Millennium Park Kazan", "Парк Тысячелетия Казань"]
    },
    sights: {
      kremlin: ["Kazan Kremlin", "Казанский Кремль"],
      kul_sharif: ["Kul Sharif Mosque", "Мечеть Кул Шариф"],
      bauman: ["Bauman Street Kazan", "Улица Баумана Казань"],
      old_sloboda: ["Old Tatar Settlement Kazan", "Старая Татарская слобода Казань"],
      farmers_palace: ["Palace of Farmers Kazan", "Дворец земледельцев Казань"],
      family_center: ["Kazan family center", "Центр семьи Казан"],
      temple_religions: ["Temple of All Religions Kazan", "Храм всех религий Казань"]
    },
    hotels: {
      nogai: ["Nogai hotel Kazan"],
      kazan_palace: ["Kazan Palace hotel"],
      courtyard: ["Courtyard Kazan Kremlin hotel"],
      mirage: ["Mirage hotel Kazan"]
    },
    excursions: {
      classic: ["Kazan Kremlin", "Kul Sharif Mosque"],
      evening: ["Kazan Kremlin evening", "Kazan night"],
      old_tatar: ["Old Tatar Settlement Kazan"],
      food_walk: ["Tatar cuisine Kazan", "Bauman Street Kazan"],
      museum_day: ["National Museum of Tatarstan Kazan", "Kazan museum"],
      viewpoints: ["Kazan panorama", "Kazan Kremlin panorama"]
    }
  };

  return unique([
    ...(overrides[sectionId]?.[item.id] || []),
    `${title} Kazan`,
    `${title} Казань`,
    `${title} ${sectionLabel(sectionId)} Kazan`,
    `${title} ${sectionLabel(sectionId)} Казань`
  ]).slice(0, 6);
}

function imageScore(image) {
  let score = 0;
  const title = String(image.title || "").toLowerCase();
  if (title.includes("kazan") || title.includes("казан")) score += 30;
  if (title.includes("logo") || title.includes("map") || title.includes("diagram")) score -= 60;
  if (image.width && image.height) {
    const ratio = image.width / image.height;
    if (ratio >= 1.15 && ratio <= 2.4) score += 20;
  }
  if (image.licenseShortName) score += 10;
  return score;
}

function isBadImageTitle(value) {
  const text = String(value || "").toLowerCase();
  return ["logo", "icon", "map", "svg", "diagram", "plan", "coat of arms"].some((marker) => text.includes(marker));
}

function parseOptions(args) {
  const valueOf = (name, fallback) => {
    const raw = args.find((arg) => arg.startsWith(`${name}=`));
    return raw ? raw.split("=").slice(1).join("=") : fallback;
  };

  return {
    sections: valueOf("--section", "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    limitPerSection: Number(valueOf("--limit-per-section", "0")) || 0,
    maxImagesPerItem: Number(valueOf("--max-images-per-item", "2")) || 2,
    searchLimit: Number(valueOf("--search-limit", "10")) || 10,
    maxImageBytes: Number(valueOf("--max-image-bytes", "7000000")) || 7000000,
    timeoutMs: Number(valueOf("--timeout-ms", "18000")) || 18000,
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force")
  };
}

function cleanSearchText(value) {
  return String(value || "")
    .replace(/[«»"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function sectionLabel(sectionId) {
  return {
    parks: "park",
    sights: "landmark",
    hotels: "hotel",
    excursions: "tour route"
  }[sectionId] || sectionId;
}
