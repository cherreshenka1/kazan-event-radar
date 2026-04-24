import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "public", "miniapp", "generated", "events");
const OVERRIDES_DIR = path.join(ROOT, "public", "miniapp", "photos", "events");
const MANIFEST_PATH = path.join(ROOT, "public", "miniapp", "event-preview-manifest.js");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DEFAULT_API_URL = "https://kazan-event-radar-api.4ereshny333.workers.dev/api/events?limit=1200";

const cliOptions = parseCliOptions(process.argv.slice(2));

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const items = await loadEventItems();
  if (!items.length) {
    console.log("No event items available for preview generation. Keeping existing previews.");
    return;
  }

  const previewMap = buildPreviewSourceMap(items);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: await resolveBrowserExecutablePath(),
    headless: !cliOptions.headed
  });

  const page = await browser.newPage({
    viewport: { width: 1200, height: 675 },
    deviceScaleFactor: 1,
    colorScheme: "light"
  });

  const manifest = {};
  const expectedFiles = new Set();
  let generatedCount = 0;
  let reusedCount = 0;

  try {
    for (const [previewKey, item] of previewMap.entries()) {
      const fileName = `${previewKey}.jpg`;
      const outputPath = path.join(OUTPUT_DIR, fileName);
      expectedFiles.add(fileName);

      const customBackground = await resolveOverrideImage(previewKey);
      const backgroundUrl = resolvePreviewBackgroundUrl(item, customBackground);
      const shouldReuse = !cliOptions.force && await fileExists(outputPath);

      if (!shouldReuse) {
        const html = buildPosterHtml(item, backgroundUrl);
        await page.setContent(html, { waitUntil: "load" });
        await page.waitForFunction(() => window.__posterReady === true, null, { timeout: 15000 });
        await page.screenshot({
          path: outputPath,
          type: "jpeg",
          quality: 84
        });
        generatedCount += 1;
      } else {
        reusedCount += 1;
      }

      manifest[previewKey] = {
        url: `./generated/events/${fileName}`,
        title: item.posterTitle || item.title || "",
        updatedAt: new Date().toISOString(),
        customBackground: Boolean(customBackground),
        sourceBackground: !customBackground && Boolean(item.imageUrl)
      };
    }
  } finally {
    await page.close().catch(() => null);
    await browser.close().catch(() => null);
  }

  if (!cliOptions.keepStale) {
    await removeStaleFiles(expectedFiles);
  }

  await writeManifest(manifest);

  console.log(`Event previews ready: ${previewMap.size}`);
  console.log(`Generated: ${generatedCount}`);
  console.log(`Reused: ${reusedCount}`);
  console.log(`Manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
}

async function loadEventItems() {
  const apiItems = cliOptions.skipApi ? [] : await fetchApiItems(cliOptions.apiUrl || DEFAULT_API_URL);
  const snapshotItems = await loadSnapshotItems();

  if (apiItems.length && snapshotItems.length) {
    return [...apiItems, ...snapshotItems];
  }

  return apiItems.length ? apiItems : snapshotItems;
}

async function fetchApiItems(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`API responded with ${response.status}`);
    }

    const payload = await response.json();
    return Array.isArray(payload?.items) ? payload.items : [];
  } catch (error) {
    console.warn(`Event preview API fetch skipped: ${error.message}`);
    return [];
  }
}

async function loadSnapshotItems() {
  const filePaths = [
    path.join(ROOT, "data", "playwright", "yandex-browser-events.json"),
    path.join(ROOT, "data", "playwright", "mts-live-events.json"),
    path.join(ROOT, "data", "playwright", "kassir-browser-events.json"),
    path.join(ROOT, "data", "playwright", "official-sport-events.json"),
    path.join(ROOT, "data", "playwright", ".tmp", "events_items.json")
  ];
  const items = [];

  for (const filePath of filePaths) {
    try {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
      const payloadItems = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
      items.push(...payloadItems);
    } catch {
      // Ignore missing local snapshots and continue with other sources.
    }
  }

  return items;
}

function buildPreviewSourceMap(items) {
  const map = new Map();

  for (const rawItem of items) {
    if (!rawItem?.title || !rawItem?.eventDate) continue;

    const item = normalizeEventItem(rawItem);
    if (!isPreviewDateAllowed(item.eventDate)) continue;
    if (!isPreviewItemAllowed(item)) continue;

    const previewKey = buildEventPreviewKey(item);
    if (!previewKey) continue;

    const current = map.get(previewKey);
    if (!current || previewItemScore(item) > previewItemScore(current)) {
      map.set(previewKey, item);
    }
  }

  return new Map(
    [...map.entries()].sort((left, right) => {
      const leftDate = String(left[1]?.eventDate || "");
      const rightDate = String(right[1]?.eventDate || "");
      return leftDate.localeCompare(rightDate, "en");
    })
  );
}

function normalizeEventItem(rawItem) {
  const title = normalizeText(rawItem?.title || rawItem?.summary || "Событие в Казани");
  return {
    id: String(rawItem?.id || ""),
    title,
    posterTitle: buildShortEventTitle(title),
    summary: cleanSummary(rawItem?.rawSummary || rawItem?.summary || rawItem?.shortSummary || rawItem?.subtitle || ""),
    shortSummary: cleanSummary(rawItem?.shortSummary || rawItem?.summary || rawItem?.subtitle || ""),
    venueTitle: normalizeText(rawItem?.venueTitle || ""),
    eventDate: normalizeDateValue(rawItem?.eventDate),
    eventHasExplicitTime: Boolean(rawItem?.eventHasExplicitTime),
    kind: resolvePreviewKind(rawItem),
    imageUrl: normalizeText(rawItem?.imageUrl || "")
  };
}

function resolvePreviewKind(rawItem) {
  const normalizedKind = normalizeText(rawItem?.kind || "").toLowerCase();
  if (normalizedKind && normalizedKind !== "events" && normalizedKind !== "event") {
    return normalizedKind;
  }

  const text = normalizePreviewText(`${rawItem?.title || ""} ${rawItem?.summary || ""} ${rawItem?.shortSummary || ""}`);
  if (/\b(матч|хоккей|футбол|волейбол|баскетбол)\b/u.test(text)) return "sport";
  if (/\b(стендап|standup)\b/u.test(text)) return "standup";
  if (/\b(спектакл|театр|постановк)\b/u.test(text)) return "theatre";
  if (/\b(выстав|экспозици)\b/u.test(text)) return "exhibition";
  if (/\b(экскурс|тур)\b/u.test(text)) return "excursion";
  if (/\b(мюзикл)\b/u.test(text)) return "musical";
  if (/\b(фестив)\b/u.test(text)) return "festival";
  if (/\b(шоу)\b/u.test(text)) return "show";
  if (/\b(дет|семейн)\b/u.test(text)) return "kids";
  return "concert";
}

function previewItemScore(item) {
  let score = 0;
  score += Math.min(200, normalizeText(item.summary).length);
  score += Math.min(80, normalizeText(item.shortSummary).length);
  score += item.venueTitle ? 35 : 0;
  score += item.eventHasExplicitTime ? 24 : 0;
  score += item.imageUrl ? 10 : 0;
  return score;
}

async function resolveBrowserExecutablePath() {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSER_PATH,
    path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1217", "chrome-win64", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error("Chromium/Chrome executable was not found. Set PLAYWRIGHT_BROWSER_PATH.");
}

async function resolveOverrideImage(previewKey) {
  const targetDir = path.join(OVERRIDES_DIR, previewKey);
  const entries = await safeReadDir(targetDir);

  const imageFile = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .find((fileName) => IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase()));

  if (!imageFile) return "";
  return pathToFileURL(path.join(targetDir, imageFile)).toString();
}

function resolvePreviewBackgroundUrl(item, overrideUrl = "") {
  if (overrideUrl) return overrideUrl;
  const imageUrl = normalizeText(item?.imageUrl || "");
  return /^https?:\/\//i.test(imageUrl) ? imageUrl : "";
}

function buildPosterHtml(item, backgroundUrl = "") {
  const palette = posterPalette(item.kind);
  const summary = escapeHtml(trim(ensureSentence(extractPreviewLead(item)), 210));
  const metaLine = escapeHtml(buildMetaLine(item));
  const title = escapeHtml(item.posterTitle || item.title || "Событие в Казани");
  const label = escapeHtml(eventKindLabel(item.kind).toUpperCase());
  const hasPhotoBackground = Boolean(backgroundUrl);
  const backgroundMarkup = hasPhotoBackground
    ? `
      <img class="poster-photo" src="${escapeHtml(backgroundUrl)}" alt="" aria-hidden="true" />
      <div class="poster-photo-overlay"></div>
    `
    : `<div class="poster-glow"></div>`;

  return `
    <!doctype html>
    <html lang="ru">
      <head>
        <meta charset="UTF-8" />
        <style>
          :root {
            color-scheme: light only;
            --start: ${palette.start};
            --mid: ${palette.mid};
            --end: ${palette.end};
            --accent: ${palette.accent};
            --glow: ${palette.glow};
            --badge: ${palette.badge};
          }

          * { box-sizing: border-box; }

          html, body {
            margin: 0;
            width: 1200px;
            height: 675px;
            overflow: hidden;
            background: #081224;
            font-family: "Segoe UI", "Inter", Arial, sans-serif;
          }

          body {
            position: relative;
            color: #f8fafc;
            background:
              radial-gradient(circle at 88% 12%, rgba(123, 243, 179, 0.18), transparent 26%),
              radial-gradient(circle at 12% 88%, rgba(59, 130, 246, 0.16), transparent 28%),
              linear-gradient(135deg, var(--start) 0%, var(--mid) 52%, var(--end) 100%);
          }

          .poster-photo {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            transform: scale(1.04);
            filter: saturate(1.04);
          }

          .poster-photo-overlay {
            position: absolute;
            inset: 0;
            background:
              linear-gradient(180deg, rgba(7, 14, 27, 0.06) 0%, rgba(7, 14, 27, 0.38) 48%, rgba(7, 14, 27, 0.76) 100%),
              linear-gradient(135deg, rgba(7, 14, 27, 0.52) 0%, rgba(7, 14, 27, 0.14) 42%, rgba(7, 14, 27, 0.58) 100%);
            backdrop-filter: blur(3px);
          }

          .poster-glow {
            position: absolute;
            inset: 0;
            background:
              radial-gradient(circle at 85% 14%, var(--glow), transparent 30%),
              radial-gradient(circle at 14% 84%, rgba(255,255,255,0.08), transparent 28%);
            filter: blur(18px);
            opacity: 0.84;
          }

          .poster-shell {
            position: relative;
            z-index: 1;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            height: 100%;
            padding: 56px 62px;
          }

          .poster-panel {
            width: min(720px, 100%);
            padding: 36px 40px 34px;
            border-radius: 34px;
            background: rgba(6, 14, 27, 0.46);
            border: 1px solid rgba(255, 255, 255, 0.12);
            box-shadow: 0 24px 70px rgba(2, 6, 23, 0.28);
            backdrop-filter: blur(18px);
          }

          .poster-topline {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 18px;
            padding: 10px 16px;
            border-radius: 999px;
            background: rgba(11, 18, 33, 0.34);
            border: 1px solid rgba(255, 255, 255, 0.12);
            color: #d9f7e9;
            font-size: 17px;
            font-weight: 700;
            letter-spacing: 0.14em;
            text-transform: uppercase;
          }

          .poster-badge {
            display: inline-flex;
            align-items: center;
            max-width: fit-content;
            margin-bottom: 16px;
            padding: 9px 16px;
            border-radius: 999px;
            background: rgba(11, 18, 33, 0.46);
            border: 1px solid rgba(255,255,255,0.12);
            color: var(--badge);
            font-size: 15px;
            font-weight: 700;
            letter-spacing: 0.12em;
            text-transform: uppercase;
          }

          h1 {
            margin: 0;
            max-width: 590px;
            font-size: 54px;
            line-height: 1.04;
            font-weight: 760;
            letter-spacing: -0.03em;
          }

          .poster-meta {
            margin-top: 18px;
            max-width: 600px;
            color: rgba(226, 232, 240, 0.95);
            font-size: 24px;
            line-height: 1.32;
            font-weight: 500;
          }

          .poster-summary {
            margin-top: 16px;
            max-width: 580px;
            color: rgba(226, 232, 240, 0.92);
            font-size: 22px;
            line-height: 1.46;
            font-weight: 450;
          }

          .poster-footer {
            display: inline-flex;
            align-items: center;
            gap: 14px;
            max-width: fit-content;
            padding: 14px 20px;
            border-radius: 999px;
            background: rgba(6, 14, 27, 0.44);
            border: 1px solid rgba(255,255,255,0.12);
            color: #f8fafc;
            font-size: 18px;
            font-weight: 650;
            box-shadow: 0 18px 45px rgba(2, 6, 23, 0.22);
          }

          .poster-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--accent), #ffffff);
            box-shadow: 0 0 0 8px rgba(255,255,255,0.06);
          }
        </style>
      </head>
      <body>
        ${backgroundMarkup}
        <main class="poster-shell">
          <section class="poster-panel">
            <div class="poster-topline">Kazan Event Radar</div>
            <div class="poster-badge">${label}</div>
            <h1>${title}</h1>
            <div class="poster-meta">${metaLine}</div>
            <div class="poster-summary">${summary}</div>
          </section>
          <div class="poster-footer">
            <span class="poster-dot" aria-hidden="true"></span>
            <span>Полная карточка события внутри приложения</span>
          </div>
        </main>
        <script>
          (() => {
            const image = document.querySelector('.poster-photo');
            if (!image) {
              window.__posterReady = true;
              return;
            }
            const done = () => { window.__posterReady = true; };
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', done, { once: true });
            if (image.complete) done();
          })();
        </script>
      </body>
    </html>
  `.trim();
}

function buildMetaLine(item) {
  const parts = [
    formatDayMonth(item.eventDate),
    formatTime(item.eventDate, item.eventHasExplicitTime),
    item.venueTitle
  ].filter(Boolean);

  return parts.join(" • ") || "Актуальная афиша Казани";
}

function extractPreviewLead(item) {
  const summary = normalizeText(item.summary || item.shortSummary || "");
  const titleFingerprints = new Set([
    normalizePreviewText(item.title || ""),
    normalizePreviewText(item.posterTitle || "")
  ].filter(Boolean));
  const sentences = summary
    .match(/[^.!?]+[.!?]?/g)
    ?.map((part) => normalizeText(part))
    .filter(Boolean) || [];

  for (const sentence of sentences) {
    const fingerprint = normalizePreviewText(sentence);
    if (!fingerprint || titleFingerprints.has(fingerprint)) continue;
    return sentence;
  }

  return summary || "Коротко, по делу и без лишнего шума — вся ключевая информация будет внутри карточки события.";
}

function buildEventPreviewKey(item) {
  const dateKey = formatDateKey(item?.eventDate);
  const titleKey = normalizePreviewEntity(item?.title || item?.summary || item?.shortSummary || "");
  const venueKey = normalizePreviewVenue(item?.venueTitle || "");
  const kindKey = normalizePreviewEntity(item?.kind || "event");
  const base = [dateKey, titleKey, venueKey, kindKey].filter(Boolean).join("|");
  if (!base) return "";
  return `${dateKey || "undated"}-${hashPreviewKey(base)}`;
}

function hashPreviewKey(value) {
  let hash = 2166136261;

  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizePreviewEntity(value) {
  return normalizePreviewText(value)
    .replace(/\b(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер класс|матч|турнир|билеты|казань|афиша)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePreviewVenue(value) {
  return normalizePreviewText(value)
    .replace(/\b(г казань|казань|лдс|мвц|крк|дк|кск|арена|концерт холл|пространство|площадка|сцена)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePreviewText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/ё/g, "е")
    .replace(/[«»"'`]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildShortEventTitle(value) {
  return trim(
    normalizeText(String(value || ""))
      .replace(/^билеты на\s+/iu, "")
      .replace(/\s+—\s+яндекс.*$/iu, "")
      .replace(/\s+на Яндекс Афише.*$/iu, "")
      .replace(/\s+на МТС Live.*$/iu, "")
      .replace(/^\d{1,2}[.:]\d{2}\s*/u, "")
      .replace(/^\d{1,2}\s+[а-яё]+\s*/iu, "")
      .replace(/^(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер-?класс)\s+/iu, "")
      .trim(),
    88
  ) || "Событие в Казани";
}

function cleanSummary(value) {
  return trim(
    normalizeText(String(value || ""))
      .replace(/Описание, даты проведения и фотографии[^.]*\./giu, "")
      .replace(/Купить билеты[^.]*\./giu, "")
      .replace(/на Яндекс Афише\.*$/giu, "")
      .replace(/на МТС Live\.*$/giu, "")
      .replace(/Подробности и билеты[^.]*$/giu, "")
      .trim(),
    320
  );
}

function normalizeDateValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function isPreviewDateAllowed(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date >= startOfMoscowDay(now) && date <= endOfMoscowYear(now);
}

function isPreviewItemAllowed(item) {
  const text = `${item?.title || ""} ${item?.summary || ""} ${item?.shortSummary || ""}`;
  if (/[ӘәӨөҮүҢңҖҗҺһ]/u.test(text)) return false;

  const normalized = normalizePreviewText(text);
  return !["розыгрыш", "авиабилеты", "авиабилет", "самолет", "самолёт"].some((keyword) => normalized.includes(normalizePreviewText(keyword)));
}

function formatDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "undated";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatDayMonth(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Дата уточняется";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long"
  }).format(date);
}

function startOfMoscowDay(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return new Date(Date.UTC(year, month - 1, day, -3, 0, 0));
}

function endOfMoscowYear(value) {
  const year = Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric"
  }).format(value));
  return new Date(Date.UTC(year + 1, 0, 1, -3, 0, 0) - 1);
}

function formatTime(value, hasExplicitTime = false) {
  if (!hasExplicitTime) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function eventKindLabel(kind) {
  return {
    concert: "Концерт",
    theatre: "Спектакль",
    show: "Шоу",
    festival: "Фестиваль",
    standup: "Стендап",
    exhibition: "Выставка",
    excursion: "Экскурсия",
    musical: "Мюзикл",
    kids: "Семейная программа",
    sport: "Спорт"
  }[kind] || "Событие";
}

function posterPalette(kind) {
  return {
    concert: { start: "#081224", mid: "#102746", end: "#1d4ed8", accent: "#60a5fa", glow: "rgba(96,165,250,0.42)", badge: "#BFDBFE" },
    theatre: { start: "#180d1f", mid: "#3b0f35", end: "#7c3aed", accent: "#c084fc", glow: "rgba(192,132,252,0.38)", badge: "#E9D5FF" },
    show: { start: "#0f172a", mid: "#0b3b44", end: "#0891b2", accent: "#67e8f9", glow: "rgba(103,232,249,0.34)", badge: "#CFFAFE" },
    festival: { start: "#1a1038", mid: "#3b1c63", end: "#9333ea", accent: "#f9a8d4", glow: "rgba(249,168,212,0.32)", badge: "#F5D0FE" },
    standup: { start: "#111827", mid: "#3f3f46", end: "#27272a", accent: "#f59e0b", glow: "rgba(245,158,11,0.24)", badge: "#FDE68A" },
    exhibition: { start: "#082032", mid: "#164e63", end: "#0f766e", accent: "#99f6e4", glow: "rgba(153,246,228,0.28)", badge: "#CCFBF1" },
    excursion: { start: "#0b1324", mid: "#12375c", end: "#2563eb", accent: "#86efac", glow: "rgba(134,239,172,0.24)", badge: "#DCFCE7" },
    musical: { start: "#1e1b4b", mid: "#4338ca", end: "#7c3aed", accent: "#fca5a5", glow: "rgba(252,165,165,0.24)", badge: "#FBCFE8" },
    sport: { start: "#091b15", mid: "#14532d", end: "#16a34a", accent: "#86efac", glow: "rgba(134,239,172,0.28)", badge: "#DCFCE7" },
    kids: { start: "#0f172a", mid: "#1d4ed8", end: "#2563eb", accent: "#fbbf24", glow: "rgba(251,191,36,0.28)", badge: "#FDE68A" }
  }[kind] || { start: "#081224", mid: "#1e293b", end: "#334155", accent: "#60a5fa", glow: "rgba(96,165,250,0.24)", badge: "#DBEAFE" };
}

async function removeStaleFiles(expectedFiles) {
  const entries = await safeReadDir(OUTPUT_DIR);

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!expectedFiles.has(entry.name)) {
      await fs.unlink(path.join(OUTPUT_DIR, entry.name)).catch(() => null);
    }
  }
}

async function writeManifest(manifest) {
  const output = `window.KAZAN_EVENT_RADAR_EVENT_PREVIEWS = ${JSON.stringify(manifest, null, 2)};\n`;
  await fs.writeFile(MANIFEST_PATH, output, "utf8");
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function ensureSentence(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  return /[.!?…]$/u.test(normalized) ? normalized : `${normalized}.`;
}

function trim(value, maxLength) {
  const normalized = normalizeText(value);
  if (!maxLength || normalized.length <= maxLength) return normalized;
  const slice = normalized.slice(0, Math.max(0, maxLength - 1)).trim();
  const sentenceEnd = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (sentenceEnd >= Math.floor(maxLength * 0.45)) return slice.slice(0, sentenceEnd + 1).trim();

  const wordBoundary = slice.lastIndexOf(" ");
  const compact = (wordBoundary >= Math.floor(maxLength * 0.45) ? slice.slice(0, wordBoundary) : slice).trim();
  return /[.!?]$/u.test(compact) ? compact : `${compact}.`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(targetPath) {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function parseCliOptions(args) {
  const options = {
    apiUrl: "",
    skipApi: false,
    force: false,
    headed: false,
    keepStale: false
  };

  for (const arg of args) {
    if (arg.startsWith("--api=")) {
      options.apiUrl = arg.slice("--api=".length);
      continue;
    }

    if (arg === "--skip-api") {
      options.skipApi = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--headed") {
      options.headed = true;
      continue;
    }

    if (arg === "--keep-stale") {
      options.keepStale = true;
    }
  }

  return options;
}
