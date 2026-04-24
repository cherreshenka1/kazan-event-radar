import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_CATALOG } from "../src/data/catalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PHOTOS_ROOT = path.join(ROOT, "public", "miniapp", "photos");
const REPORT_JSON = path.join(ROOT, "data", "catalog-imports", "photo-coverage-report.json");
const REPORT_MD = path.join(ROOT, "docs", "catalog-photo-coverage.md");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const SECTION_ORDER = [
  "parks",
  "sights",
  "hotels",
  "excursions",
  "food",
  "routes",
  "active",
  "masterclasses",
  "roadtrip"
];

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  if (process.argv.includes("--ensure-folders")) {
    await ensureCatalogPhotoFolders();
  }

  const report = await buildReport();

  await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
  await fs.mkdir(path.dirname(REPORT_MD), { recursive: true });
  await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(REPORT_MD, buildMarkdown(report), "utf8");

  console.log(`Catalog photo coverage: ${report.totals.withPhotos}/${report.totals.itemCount} cards with photos`);
  console.log(`JSON: ${path.relative(ROOT, REPORT_JSON)}`);
  console.log(`Docs: ${path.relative(ROOT, REPORT_MD)}`);
}

async function ensureCatalogPhotoFolders() {
  for (const sectionId of SECTION_ORDER) {
    const items = Array.isArray(BASE_CATALOG[sectionId]?.items) ? BASE_CATALOG[sectionId].items : [];

    for (const item of items) {
      const folderPath = path.join(PHOTOS_ROOT, sectionId, item.id);
      const files = await readImageFiles(folderPath);
      await fs.mkdir(folderPath, { recursive: true });

      if (!files.length) {
        await fs.writeFile(path.join(folderPath, ".gitkeep"), "", "utf8");
      }
    }
  }
}

async function buildReport() {
  const sections = [];

  for (const sectionId of SECTION_ORDER) {
    const catalogSection = BASE_CATALOG[sectionId];
    const items = Array.isArray(catalogSection?.items) ? catalogSection.items : [];
    const sectionRows = [];

    for (const item of items) {
      const folderPath = path.join(PHOTOS_ROOT, sectionId, item.id);
      const files = await readImageFiles(folderPath);
      const folderExists = await exists(folderPath);
      const status = files.length ? "ok" : folderExists ? "empty" : "missing";

      sectionRows.push({
        id: item.id,
        title: item.title || item.id,
        folder: path.relative(ROOT, folderPath).replaceAll("\\", "/"),
        status,
        fileCount: files.length,
        files
      });
    }

    sections.push({
      sectionId,
      label: catalogSection?.title || sectionLabel(sectionId),
      itemCount: sectionRows.length,
      withPhotos: sectionRows.filter((item) => item.status === "ok").length,
      emptyFolders: sectionRows.filter((item) => item.status === "empty").length,
      missingFolders: sectionRows.filter((item) => item.status === "missing").length,
      items: sectionRows
    });
  }

  const totals = sections.reduce(
    (acc, section) => {
      acc.itemCount += section.itemCount;
      acc.withPhotos += section.withPhotos;
      acc.emptyFolders += section.emptyFolders;
      acc.missingFolders += section.missingFolders;
      return acc;
    },
    {
      itemCount: 0,
      withPhotos: 0,
      emptyFolders: 0,
      missingFolders: 0
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    photosRoot: path.relative(ROOT, PHOTOS_ROOT).replaceAll("\\", "/"),
    totals,
    sections
  };
}

async function readImageFiles(folderPath) {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((fileName) => IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
      .sort((left, right) => left.localeCompare(right, "ru", { numeric: true, sensitivity: "base" }));
  } catch {
    return [];
  }
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildMarkdown(report) {
  const lines = [
    "# Покрытие фотографиями каталога",
    "",
    `Обновлено: ${report.generatedAt}`,
    "",
    "Этот файл помогает быстро понять, куда нужно добавить фотографии для карточек Mini App.",
    "",
    "Рекомендуемый формат: `cover.jpg`, `01.jpg`, `02.jpg` или `.webp` внутри папки нужной карточки.",
    "",
    `Итого: ${report.totals.withPhotos}/${report.totals.itemCount} карточек с фото.`,
    "",
    `Пустых папок: ${report.totals.emptyFolders}.`,
    "",
    `Папок не хватает: ${report.totals.missingFolders}.`,
    ""
  ];

  for (const section of report.sections) {
    lines.push(`## ${section.label}`);
    lines.push("");
    lines.push(`Фото есть: ${section.withPhotos}/${section.itemCount}. Пустые папки: ${section.emptyFolders}. Нет папки: ${section.missingFolders}.`);
    lines.push("");

    const problemItems = section.items.filter((item) => item.status !== "ok");
    if (!problemItems.length) {
      lines.push("Все карточки раздела уже имеют изображения.");
      lines.push("");
      continue;
    }

    lines.push("| Статус | Карточка | Папка |");
    lines.push("| --- | --- | --- |");

    for (const item of problemItems) {
      lines.push(`| ${statusLabel(item.status)} | ${escapeMarkdown(item.title)} | \`${item.folder}\` |`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function sectionLabel(sectionId) {
  return {
    parks: "Парки",
    sights: "Достопримечательности",
    hotels: "Отели",
    excursions: "Экскурсии",
    food: "Еда",
    routes: "Пешие маршруты",
    active: "Активный отдых",
    masterclasses: "Мастер-классы",
    roadtrip: "На машине"
  }[sectionId] || sectionId;
}

function statusLabel(status) {
  return {
    empty: "папка пустая",
    missing: "нет папки"
  }[status] || "есть фото";
}

function escapeMarkdown(value) {
  return String(value || "").replaceAll("|", "\\|");
}
