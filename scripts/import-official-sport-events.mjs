import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import sourceConfig from "../config/sources.json" with { type: "json" };
import { mergeImportedPayloadToKv } from "./lib/import-payload-to-kv.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "data", "playwright", "official-sport-events.json");
const cliOptions = parseCliOptions(process.argv.slice(2));

const SOURCES = (sourceConfig.sources || [])
  .filter((source) => source.enabled && source.type === "official_sport_schedule")
  .filter((source) => cliOptions.sourceIds.length === 0 || cliOptions.sourceIds.includes(source.id));

const MONTHS = {
  января: 0,
  февраль: 1,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11
};

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });

  if (!SOURCES.length) {
    throw new Error("No enabled official sport sources matched the current filters.");
  }

  const collected = [];
  const sourceStats = [];

  for (const source of SOURCES) {
    console.log(`Collecting source: ${source.id}`);
    const html = await fetchText(source.url, source.url);
    const items = source.parser === "rubin"
      ? parseRubinMatches(html, source)
      : source.parser === "unics"
        ? parseUnicsMatches(html, source)
        : [];

    console.log(`Imported items: ${items.length}`);
    collected.push(...items);
    sourceStats.push({
      id: source.id,
      name: source.name,
      collectedLinks: items.length,
      importedItems: items.length
    });
  }

  const deduped = dedupeItems(collected);
  const payload = {
    source: "browser_import",
    mode: "merge",
    syncedAt: new Date().toISOString(),
    sourceStats,
    reportedImportedCount: deduped.length,
    items: deduped
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Output: ${OUTPUT_PATH}`);

  if (cliOptions.noUpload) {
    console.log("Skip upload: --no-upload");
    return;
  }

  const result = await mergeImportedPayloadToKv(payload, {
    log: console.log
  });
  console.log(`Uploaded official sport events: ${result.imported || 0}`);
}

function parseRubinMatches(html, source) {
  const $ = cheerio.load(html);
  return $("tr")
    .toArray()
    .map((row) => parseRubinRow($, row, source))
    .filter(Boolean);
}

function parseRubinRow($, row, source) {
  const title = normalizeText($(row).find(".arena span").first().text());
  if (!title) return null;

  const dateBlock = $(row).find(".date").first();
  const dateText = normalizeText(dateBlock.clone().find("a").remove().end().text());
  const eventDate = parseRuDateText(dateText);
  if (!eventDate || isBeforeToday(eventDate)) return null;

  const arenaText = normalizeText($(row).find(".arena").first().text());
  const venueTitle = normalizeText(arenaText.replace(title, "")) || source.homeVenue || "Казань";
  const url = toAbsoluteUrl(source.url, $(row).find(".arena a").first().attr("href") || $(row).find(".date a").first().attr("href") || source.url);
  const imageCandidates = $(row)
    .find("img[src]")
    .toArray()
    .map((image) => toAbsoluteUrl(source.url, $(image).attr("src")))
    .filter(Boolean);
  const isHomeMatch = title.toLowerCase().startsWith("рубин");

  return {
    sourceId: source.id,
    sourceName: source.name,
    section: "sport",
    title,
    summary: [
      `Официальный матч ФК «Рубин»: ${title}.`,
      isHomeMatch
        ? `Домашняя игра пройдет${venueTitle ? ` на площадке ${venueTitle}` : " в Казани"}.`
        : venueTitle
          ? `Выездная игра пройдет на площадке ${venueTitle}.`
          : "Матч включен в официальный календарь клуба.",
      dateText ? `Время в календаре клуба: ${dateText}.` : ""
    ].filter(Boolean).join(" "),
    shortSummary: title,
    imageUrl: imageCandidates[1] || imageCandidates[0] || "",
    venueTitle,
    url,
    eventDate,
    eventHasExplicitTime: /\b\d{1,2}:\d{2}\b/u.test(dateText),
    baseScore: isHomeMatch ? 70 : 66
  };
}

function parseUnicsMatches(html, source) {
  const $ = cheerio.load(html);
  return $("tr[data-id]")
    .toArray()
    .map((row) => parseUnicsRow($, row, source))
    .filter(Boolean);
}

function parseUnicsRow($, row, source) {
  const cells = $(row).find("td").toArray();
  if (cells.length < 6) return null;

  const rowId = normalizeText($(row).attr("data-id"));
  const tournament = normalizeText($(cells[0]).find("img").attr("title"));
  const stage = normalizeText($(cells[1]).text());
  const dateRaw = normalizeText($(cells[2]).text());
  const timeRaw = normalizeText($(cells[3]).text());
  const home = $(cells[4]).find(".fa-home").length > 0;
  const opponent = normalizeText($(cells[5]).find("b").text());
  if (!opponent) return null;

  const eventDate = parseNumericDateTime(dateRaw);
  if (!eventDate || isBeforeToday(eventDate)) return null;

  const locationText = normalizeText($(cells[5]).text().replace(opponent, ""));
  const venueTitle = home ? (source.homeVenue || "Баскет-холл") : locationText;
  const title = `УНИКС — ${opponent}`;
  const imageUrl = toAbsoluteUrl(source.url, $(cells[0]).find("img").attr("src") || "");

  return {
    sourceId: source.id,
    sourceName: source.name,
    section: "sport",
    title,
    summary: [
      `Официальный матч БК «УНИКС»: ${title}.`,
      tournament ? `Турнир: ${tournament}.` : "",
      stage ? `Стадия: ${stage}.` : "",
      home
        ? `Домашняя встреча пройдет${venueTitle ? ` в ${venueTitle}` : " в Казани"}.`
        : venueTitle
          ? `Выездная встреча пройдет в ${venueTitle}.`
          : "Матч указан в официальном календаре клуба."
    ].filter(Boolean).join(" "),
    shortSummary: title,
    imageUrl,
    venueTitle,
    url: normalizeText(source.url),
    eventDate,
    eventHasExplicitTime: Boolean(timeRaw),
    baseScore: home ? 68 : 64,
    metaId: rowId
  };
}

function dedupeItems(items) {
  const unique = new Map();

  for (const item of items) {
    const key = [
      formatDateOnly(item.eventDate),
      normalizeText(item.title).toLowerCase(),
      normalizeText(item.venueTitle).toLowerCase(),
      normalizeText(item.sourceId).toLowerCase()
    ].join("|");

    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }

  return [...unique.values()];
}

async function fetchText(url, referer = "") {
  const response = await fetch(url, {
    headers: {
      "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      ...(referer ? { referer } : {})
    },
    signal: AbortSignal.timeout(45000)
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

function parseRuDateText(value) {
  const text = normalizeText(value).toLowerCase();
  const match = text.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?(?:,\s*[а-яё]+)?(?:\s+(\d{1,2}):(\d{2}))?/u);
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2]];
  if (Number.isNaN(day) || typeof month !== "number") return null;

  const now = new Date();
  const inferredYear = match[3] ? Number(match[3]) : inferYear(month, day, now);
  const hour = match[4] ? Number(match[4]) : 12;
  const minute = match[5] ? Number(match[5]) : 0;
  return toMoscowIso(inferredYear, month, day, hour, minute);
}

function parseNumericDateTime(value) {
  const text = normalizeText(value);
  const match = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?)?/u);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const year = Number(match[3]);
  const hour = match[4] ? Number(match[4]) : 12;
  const minute = match[5] ? Number(match[5]) : 0;
  return toMoscowIso(year, month, day, hour, minute);
}

function toMoscowIso(year, month, day, hour = 12, minute = 0) {
  return new Date(Date.UTC(year, month, day, hour - 3, minute, 0)).toISOString();
}

function inferYear(month, day, now = new Date()) {
  const year = now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, month, day));
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return candidate < monthAgo ? year + 1 : year;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#039;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toAbsoluteUrl(origin, value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  try {
    return new URL(raw, origin).toString();
  } catch {
    return raw;
  }
}

function isBeforeToday(iso) {
  const date = new Date(iso);
  const now = new Date();
  const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return date.getTime() < startOfTodayUtc;
}

function formatDateOnly(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function parseCliOptions(args) {
  const options = {
    noUpload: false,
    sourceIds: []
  };

  for (const arg of args) {
    if (arg === "--no-upload") {
      options.noUpload = true;
      continue;
    }

    if (arg.startsWith("--source=")) {
      options.sourceIds.push(arg.slice("--source=".length));
    }
  }

  return options;
}
