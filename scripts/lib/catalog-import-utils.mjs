import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

export function projectPath(...parts) {
  return path.join(process.cwd(), ...parts);
}

export function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function ensureParentDir(filePath) {
  ensureDir(path.dirname(filePath));
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, payload) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function toSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "source";
}

export function cleanText(value, maxLength = 280) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

export async function fetchPageSnapshot(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return {
      url: url || "",
      ok: false,
      status: 0,
      fetchedAt: new Date().toISOString(),
      error: "Invalid or empty URL"
    };
  }

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; KazanEventRadar/1.0; +https://github.com/cherreshenka1/kazan-event-radar)"
      }
    });

    const html = await response.text();
    const $ = cheerio.load(html);
    const title = cleanText($("title").first().text(), 160);
    const h1 = cleanText($("h1").first().text(), 160);
    const description = cleanText(
      $('meta[name="description"]').attr("content")
      || $('meta[property="og:description"]').attr("content")
      || $("article p").first().text()
      || $("main p").first().text()
      || $("p").first().text(),
      400
    );
    const rawImage = (
      $('meta[property="og:image"]').attr("content")
      || $('meta[name="twitter:image"]').attr("content")
      || $("img").first().attr("src")
      || ""
    ).trim();
    const image = resolveAbsoluteUrl(rawImage, response.url);

    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      fetchedAt: new Date().toISOString(),
      title,
      h1,
      description,
      image
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      fetchedAt: new Date().toISOString(),
      error: error.message
    };
  }
}

export function pickPrimarySnapshot(snapshots) {
  const okSnapshots = Array.isArray(snapshots) ? snapshots.filter((entry) => entry?.ok) : [];
  if (!okSnapshots.length) return null;

  return okSnapshots.find((entry) => entry.image && !isProbablyDecorativeImage(entry.image))
    || okSnapshots.find((entry) => entry.image)
    || okSnapshots[0]
    || null;
}

function resolveAbsoluteUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) return raw;

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function isProbablyDecorativeImage(url) {
  const normalized = String(url || "").toLowerCase();
  if (!normalized) return true;

  return normalized.endsWith(".svg")
    || normalized.includes("logo")
    || normalized.includes("favicon")
    || normalized.includes("icon")
    || normalized.includes("/social")
    || normalized.includes("socials/");
}
