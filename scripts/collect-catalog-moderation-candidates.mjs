import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../src/data/catalog.js";
import { cleanText, fetchPageSnapshot, projectPath } from "./lib/catalog-import-utils.mjs";
import { readRemoteJson } from "./lib/remote-kv-json.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const MODERATION_ROOT = projectPath("data", "catalog-moderation");
const PHOTO_CANDIDATES_ROOT = path.join(MODERATION_ROOT, "photo-candidates");
const PUBLISHED_PHOTOS_ROOT = projectPath("public", "miniapp", "photos");
const REPORT_JSON = path.join(MODERATION_ROOT, "review-board.json");
const REPORT_MD = path.join(MODERATION_ROOT, "review-board.md");
const REPORT_HTML = path.join(MODERATION_ROOT, "review-gallery.html");
const APPROVALS_TEMPLATE = path.join(MODERATION_ROOT, "approvals.template.json");
const PHOTO_LEARNING_PATH = projectPath("config", "photo-learning.json");
const SECTION_ORDER = ["parks", "sights", "hotels", "excursions", "food", "routes", "active", "masterclasses", "roadtrip"];
const IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const IMAGE_EXTENSIONS_BY_TYPE = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

const options = parseOptions(process.argv.slice(2));
let photoLearning = null;

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(PHOTO_CANDIDATES_ROOT, { recursive: true });
  photoLearning = await loadPhotoLearning();

  const sections = [];
  const approvals = {
    generatedAt: new Date().toISOString(),
    instructions: [
      "Copy this file to config/catalog-moderation-approvals.json.",
      "Set approved: true only for cards checked by a human moderator.",
      "Keep photoCandidateFile only for images without watermarks, foreign branding, or irrelevant objects.",
      "Run npm run catalog:moderation:apply after review."
    ],
    items: []
  };

  for (const sectionId of SECTION_ORDER) {
    if (options.sections.length && !options.sections.includes(sectionId)) continue;

    const section = CATALOG[sectionId];
    if (!Array.isArray(section?.items)) continue;

    const sourceItems = options.missingPhotosOnly
      ? await filterItemsWithoutPublishedPhotos(sectionId, section.items)
      : section.items;
    const limit = options.limitPerSection || sourceItems.length;
    const items = [];

    for (const item of sourceItems.slice(0, limit)) {
      const result = await collectItemCandidates(sectionId, item);
      items.push(result);
      approvals.items.push({
        section: sectionId,
        id: item.id,
        title: item.title,
        approved: false,
        photoCandidateFile: result.photoCandidates[0]?.file || "",
        photoSearchQuery: result.photoSearchQueries[0] || "",
        targetFileName: "1",
        note: ""
      });
    }

    sections.push({
      sectionId,
      title: section.title || sectionId,
      itemCount: items.length,
      items
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "catalog_moderation_candidates",
    options: {
      sections: options.sections,
      missingPhotosOnly: options.missingPhotosOnly,
      limitPerSection: options.limitPerSection,
      maxSourcesPerItem: options.maxSourcesPerItem,
      maxImagesPerItem: options.maxImagesPerItem
    },
    photoLearning: {
      localConfig: path.relative(ROOT, PHOTO_LEARNING_PATH).replaceAll("\\", "/"),
      remoteFeedbackItems: countPhotoLearningEntries(photoLearning?.remote),
      localApprovedItems: countPhotoLearningEntries(photoLearning?.local?.approved),
      localRejectedItems: countPhotoLearningEntries(photoLearning?.local?.rejected),
      scoring: "Candidates are sorted by source trust, prior manager feedback, URL risk markers, byte size, image dimensions, and local style rules."
    },
    legalModel: {
      text: "Draft texts are short summaries based on catalog facts and source metadata. Edit them before publication if needed.",
      photos: "Downloaded files are candidates only. They are not published until approved by the project owner.",
      warning: "Do not approve images with third-party watermarks, visible service branding, advertising labels, or unclear rights."
    },
    sections
  };

  await fs.mkdir(MODERATION_ROOT, { recursive: true });
  await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(REPORT_MD, buildMarkdown(report), "utf8");
  await fs.writeFile(REPORT_HTML, buildHtmlGallery(report), "utf8");
  await fs.writeFile(APPROVALS_TEMPLATE, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");

  console.log(`Catalog moderation board: ${path.relative(ROOT, REPORT_MD)}`);
  console.log(`Catalog moderation gallery: ${path.relative(ROOT, REPORT_HTML)}`);
  console.log(`Approvals template: ${path.relative(ROOT, APPROVALS_TEMPLATE)}`);
  console.log(`Photo candidates: ${path.relative(ROOT, PHOTO_CANDIDATES_ROOT)}`);
}

async function filterItemsWithoutPublishedPhotos(sectionId, items) {
  const result = [];

  for (const item of items || []) {
    if (!(await hasPublishedPhotos(sectionId, item.id))) {
      result.push(item);
    }
  }

  return result;
}

async function hasPublishedPhotos(sectionId, itemId) {
  try {
    const folder = path.join(PUBLISHED_PHOTOS_ROOT, sectionId, itemId);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && IMAGE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  } catch {
    return false;
  }
}

async function collectItemCandidates(sectionId, item) {
  const sourceUrls = collectSourceUrls(item);
  const snapshots = [];

  for (const source of sourceUrls.slice(0, options.maxSourcesPerItem)) {
    const snapshot = await fetchPageSnapshot(source.url);
    snapshots.push({
      label: source.label,
      url: source.url,
      ok: snapshot.ok,
      status: snapshot.status,
      title: snapshot.h1 || snapshot.title || "",
      description: snapshot.description || "",
      image: snapshot.image || "",
      error: snapshot.error || ""
    });
  }

  const photoSearchQueries = buildPhotoSearchQueries(sectionId, item, snapshots);
  let imageUrls = unique([
    item.externalPreviewUrl,
    item.imageUrl,
    ...snapshots.map((snapshot) => snapshot.image),
    ...(Array.isArray(item.photoLinks) ? item.photoLinks.map((link) => link.url).filter((url) => /^https?:\/\//i.test(url || "")) : [])
  ]).filter(isAllowedCandidateImageUrl);

  if (!imageUrls.length) {
    imageUrls = await fetchCommonsImageUrls(photoSearchQueries);
  }

  const photoCandidates = [];
  const seenPhotoKeys = new Set();
  let index = 1;

  for (const url of imageUrls.slice(0, Math.max(options.maxImagesPerItem * 4, options.maxImagesPerItem))) {
    const downloaded = await downloadImageCandidate(sectionId, item.id, url, index, { sectionId, item });
    if (downloaded) {
      const key = normalizePhotoUrlKey(downloaded.sourceUrl || url);
      if (seenPhotoKeys.has(key)) continue;
      seenPhotoKeys.add(key);
      photoCandidates.push(downloaded);
      index += 1;
    }
    if (photoCandidates.length >= options.maxImagesPerItem) break;
  }

  if (photoCandidates.length < options.maxImagesPerItem) {
    const fallbackUrls = (await fetchCommonsImageUrls(photoSearchQueries))
      .filter((url) => !imageUrls.includes(url))
      .filter((url) => !seenPhotoKeys.has(normalizePhotoUrlKey(url)));

    for (const url of fallbackUrls.slice(0, Math.max(options.maxImagesPerItem * 3, options.maxImagesPerItem))) {
      const downloaded = await downloadImageCandidate(sectionId, item.id, url, index, { sectionId, item });
      if (downloaded) {
        const key = normalizePhotoUrlKey(downloaded.sourceUrl || url);
        if (seenPhotoKeys.has(key)) continue;
        seenPhotoKeys.add(key);
        photoCandidates.push(downloaded);
        index += 1;
      }
      if (photoCandidates.length >= options.maxImagesPerItem) break;
    }
  }

  photoCandidates.sort((left, right) => Number(right.score || 0) - Number(left.score || 0));

  return {
    section: sectionId,
    id: item.id,
    title: item.title,
    subtitle: item.subtitle || "",
    sourceUrl: item.sourceUrl || "",
    sourceCount: sourceUrls.length,
    snapshots,
    draft: buildDraft(sectionId, item, snapshots),
    photoCandidates,
    photoSearchQueries,
    moderationNotes: buildModerationNotes(sectionId, item, photoCandidates, snapshots)
  };
}

function collectSourceUrls(item) {
  const refs = item.sourceRefs && typeof item.sourceRefs === "object" ? item.sourceRefs : {};
  const entries = [
    ["source", item.sourceUrl],
    ["official", refs.officialSite],
    ["guide", refs.guide],
    ["cityGuide", refs.cityGuide],
    ["booking", item.bookingUrl],
    ["review", item.reviewUrl]
  ];

  return uniqueByUrl(entries
    .map(([label, url]) => ({ label, url: String(url || "").trim() }))
    .filter((entry) => /^https?:\/\//i.test(entry.url))
    .filter((entry) => !entry.url.includes("yandex.ru/maps/?mode=search")));
}

async function downloadImageCandidate(sectionId, itemId, url, index, context = {}) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(18000),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; KazanEventRadar/1.0; +https://github.com/cherreshenka1/kazan-event-radar)",
        "accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8"
      }
    });

    if (!response.ok) return null;

    const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const extension = IMAGE_EXTENSIONS_BY_TYPE[contentType] || extensionFromUrl(url);
    if (!extension || extension === ".svg") return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 6000 || bytes.byteLength > options.maxImageBytes) return null;
    const dimensions = readImageDimensions(bytes, contentType);
    const quality = scorePhotoCandidate({
      url,
      finalUrl: response.url,
      contentType,
      bytes: bytes.byteLength,
      dimensions,
      sectionId: context.sectionId || sectionId,
      item: context.item || { id: itemId }
    });

    const folder = path.join(PHOTO_CANDIDATES_ROOT, sectionId, itemId);
    await fs.mkdir(folder, { recursive: true });

    const fileName = `candidate-${String(index).padStart(2, "0")}${extension}`;
    const filePath = path.join(folder, fileName);
    const metaPath = path.join(folder, `${fileName}.json`);
    await fs.writeFile(filePath, bytes);
    await fs.writeFile(metaPath, `${JSON.stringify({
      sourceUrl: url,
      finalUrl: response.url,
      contentType,
      bytes: bytes.byteLength,
      dimensions,
      score: quality.score,
      scoreReasons: quality.reasons,
      riskReasons: quality.risks,
      downloadedAt: new Date().toISOString(),
      moderation: "Approve only if there is no watermark, no foreign service branding, and the image is relevant."
    }, null, 2)}\n`, "utf8");

    return {
      file: path.relative(ROOT, filePath).replaceAll("\\", "/"),
      sourceUrl: url,
      bytes: bytes.byteLength,
      contentType,
      dimensions,
      score: quality.score,
      scoreReasons: quality.reasons,
      riskReasons: quality.risks
    };
  } catch {
    return null;
  }
}

async function fetchCommonsImageUrls(queries) {
  const urls = [];

  for (const query of queries.slice(0, 3)) {
    try {
      const apiUrl = new URL("https://commons.wikimedia.org/w/api.php");
      apiUrl.searchParams.set("action", "query");
      apiUrl.searchParams.set("format", "json");
      apiUrl.searchParams.set("generator", "search");
      apiUrl.searchParams.set("gsrnamespace", "6");
      apiUrl.searchParams.set("gsrlimit", "8");
      apiUrl.searchParams.set("gsrsearch", query);
      apiUrl.searchParams.set("prop", "imageinfo");
      apiUrl.searchParams.set("iiprop", "url|mime|size");

      const response = await fetch(apiUrl, {
        signal: AbortSignal.timeout(14000),
        headers: {
          "user-agent": "KazanEventRadar/1.0 (photo moderation candidates; https://github.com/cherreshenka1/kazan-event-radar)"
        }
      });
      if (!response.ok) continue;

      const payload = await response.json();
      const pages = Object.values(payload?.query?.pages || {});
      for (const page of pages) {
        const image = page.imageinfo?.[0];
        if (!image?.url || !isAllowedCandidateImageUrl(image.url)) continue;
        if (image.mime && !IMAGE_EXTENSIONS_BY_TYPE[String(image.mime).toLowerCase()]) continue;
        if (image.size && image.size > options.maxImageBytes) continue;
        urls.push(image.url);
      }
    } catch {
      // Commons is a fallback only; source candidates still work if this fails.
    }

    if (urls.length >= options.maxImagesPerItem) break;
  }

  return unique(urls);
}

function buildDraft(sectionId, item, snapshots) {
  const sourceSummary = cleanText(snapshots.find((snapshot) => snapshot.description)?.description || "", 220);
  return {
    title: item.title,
    subtitle: item.subtitle || sectionLabel(sectionId),
    description: buildSafeDescription(sectionId, item, sourceSummary),
    highlights: buildSafeHighlights(sectionId, item),
    howToGet: item.howToGet || "",
    sourceUrl: item.sourceUrl || snapshots.find((snapshot) => snapshot.ok)?.url || ""
  };
}

function buildSafeDescription(sectionId, item, sourceSummary) {
  const base = cleanText(item.description || item.bestFor || item.reviewSummary || item.subtitle || "", 260);
  const sourceHint = sourceSummary ? `Source context: ${sourceSummary}` : "";
  const sectionHint = {
    food: "Final card should focus on cuisine, signature dishes, atmosphere, interior, and review-based expectations.",
    active: "Final card should show the activity format, who it suits, logistics, and what to check before visiting.",
    masterclasses: "Final card should show what the guest will make, who the format suits, and where to confirm booking.",
    roadtrip: "Final card should explain why to go, how much time to plan, and whether it is reachable without a car.",
    routes: "Final card should show route pace, key stops, and a convenient starting point."
  }[sectionId] || "Final card should keep the description short, concrete, and useful for planning.";

  return [base, sourceHint, sectionHint].filter(Boolean).map((part) => cleanText(part, 260)).join("\n\n");
}

function buildSafeHighlights(sectionId, item) {
  const values = [
    ...(Array.isArray(item.highlights) ? item.highlights : []),
    ...(Array.isArray(item.features) ? item.features : []),
    item.bestFor,
    item.timing
  ].filter(Boolean);

  return unique(values).slice(0, sectionId === "food" ? 5 : 4).map((value) => cleanText(value, 90));
}

function buildModerationNotes(sectionId, item, photoCandidates, snapshots) {
  const notes = [];
  if (!photoCandidates.length) notes.push("Needs a manual photo pick or more image sources.");
  if (photoCandidates[0]?.riskReasons?.length) notes.push(`Best photo has risks: ${photoCandidates[0].riskReasons.join(", ")}.`);
  if (photoCandidates[0] && Number(photoCandidates[0].score || 0) < 45) notes.push("Best photo score is low; review carefully or request another preview.");
  if (!item.sourceUrl && !snapshots.some((snapshot) => snapshot.ok)) notes.push("No reliable source attached.");
  if (sectionId === "food" && !item.reviewSummary) notes.push("Restaurant card should include a short review-based summary.");
  if (sectionId === "roadtrip" && !item.howToGet) notes.push("Roadtrip card needs clearer logistics.");
  return notes;
}

function buildPhotoSearchQueries(sectionId, item, snapshots) {
  const title = cleanText(item.title || item.subtitle || sectionLabel(sectionId), 80);
  const venueOrType = cleanText(item.venueTitle || item.category || sectionLabel(sectionId), 80);
  const snapshotTitle = cleanText(snapshots.find((snapshot) => snapshot.title)?.title || "", 80);
  const commonsFriendlyQueries = sectionCommonsQueries(sectionId, item.id, title);

  return unique([
    ...commonsFriendlyQueries,
    `${title} Казань фото`,
    `${title} ${venueOrType} Казань`,
    snapshotTitle ? `${snapshotTitle} Казань фото` : "",
    sectionId === "masterclasses" ? `${title} мастер-класс Казань фото` : "",
    sectionId === "food" ? `${title} ресторан Казань интерьер блюда` : "",
    sectionId === "active" ? `${title} активный отдых Казань фото` : ""
  ]).slice(0, 6);
}

function masterclassCommonsQueries(itemId, title) {
  const byId = {
    pottery: ["pottery workshop", "ceramic workshop"],
    cooking: ["cooking class", "culinary workshop"],
    painting: ["painting workshop", "art class"],
    embroidery: ["embroidery workshop", "textile workshop"],
    candles: ["candle making workshop"],
    floristics: ["floristry workshop", "flower arrangement"],
    jewelry: ["jewelry making workshop"],
    soap_cosmetics: ["soap making workshop", "natural cosmetics workshop"],
    perfume: ["perfume workshop", "perfume making"],
    leather: ["leather craft workshop"],
    mosaic: ["mosaic workshop", "stained glass workshop"],
    resin_art: ["resin art workshop", "epoxy resin art"],
    barista: ["barista workshop", "coffee brewing class"],
    tea_ceremony: ["tea ceremony", "tea tasting"],
    calligraphy: ["calligraphy workshop", "lettering workshop"]
  };

  return byId[itemId] || [`${title} workshop`];
}

function sectionCommonsQueries(sectionId, itemId, title) {
  if (sectionId === "masterclasses") return masterclassCommonsQueries(itemId, title);

  const bySectionAndId = {
    parks: {
      elmay: ["Elmay Kazan park", "children park Kazan", "children playground park"],
      festival_boulevard: ["Kazan festival boulevard", "urban boulevard park", "public park boulevard"],
      lebyazhye_beach: ["Lake Lebyazhye Kazan", "Lebyazhye lake Kazan", "lake beach"]
    },
    hotels: {
      doubletree: ["DoubleTree by Hilton Kazan", "hotel lobby", "hotel room"],
      ramada: ["Ramada Kazan", "hotel lobby", "hotel room"],
      bilyar_palace: ["Bilyar Palace Kazan", "hotel lobby", "hotel room"]
    },
    food: {
      tugan_avylym: ["Tugan Avylym Kazan", "Tatar village Kazan", "Tatar cuisine restaurant"],
      tatar_by_tubatay: ["Tatar cuisine", "restaurant interior", "chak chak"],
      ichi: ["Japanese restaurant interior", "cocktail bar interior", "sushi restaurant"],
      cheeseria: ["Italian restaurant interior", "cheese restaurant", "restaurant pasta"]
    },
    active: {
      tiki_viki: ["indoor family entertainment center", "indoor playground", "family amusement park"],
      quad_bike_rides: ["quad bike riding", "ATV tour", "off road quad bike"],
      boat_rental: ["boat rental", "motor boat river", "rowing boat rental"],
      kazan_flights: ["small aircraft sightseeing flight", "light aircraft", "aerial sightseeing"],
      skydiving: ["skydiving", "parachute jump", "tandem skydive"]
    }
  };

  return bySectionAndId[sectionId]?.[itemId] || [];
}

function buildMarkdown(report) {
  const lines = [
    "# Catalog card moderation",
    "",
    `Updated: ${report.generatedAt}`,
    "",
    "This is a working board. Photo files are candidates only and are not published automatically.",
    "",
    "## Workflow",
    "",
    "1. Open `data/catalog-moderation/photo-candidates`.",
    "2. Check images: no watermarks, no foreign branding, no irrelevant pictures.",
    "3. Copy `data/catalog-moderation/approvals.template.json` to `config/catalog-moderation-approvals.json`.",
    "4. Set `approved: true` and keep the selected `photoCandidateFile` for approved cards only.",
    "5. Run `npm run catalog:moderation:apply`.",
    "",
    "## Summary",
    ""
  ];

  for (const section of report.sections) {
    const withPhotos = section.items.filter((item) => item.photoCandidates.length).length;
    lines.push(`- ${section.title}: ${withPhotos}/${section.itemCount} cards with photo candidates`);
  }

  for (const section of report.sections) {
    lines.push("", `## ${section.title}`, "");
    lines.push("| Card | Photo candidates | Sources | Photo search | Notes |");
    lines.push("| --- | ---: | ---: | --- | --- |");

    for (const item of section.items) {
      const searchHint = item.photoSearchQueries?.[0] || "";
      const topScore = item.photoCandidates[0]?.score ?? "";
      lines.push(`| ${escapeMarkdown(item.title)} | ${item.photoCandidates.length}${topScore !== "" ? ` / score ${topScore}` : ""} | ${item.sourceCount} | ${escapeMarkdown(searchHint)} | ${escapeMarkdown(item.moderationNotes.join("; ") || "ready for review")} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildHtmlGallery(report) {
  const cards = report.sections.flatMap((section) => section.items.map((item) => ({ section, item })));
  const withPhotos = cards.filter(({ item }) => item.photoCandidates.length).length;

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kazan Event Radar catalog moderation</title>
    <style>
      :root { color-scheme: light dark; --bg: #eef4fb; --card: #ffffff; --text: #172235; --muted: #607086; --border: #d8e2ef; --accent: #2563eb; }
      @media (prefers-color-scheme: dark) { :root { --bg: #101927; --card: #162235; --text: #f4f7fb; --muted: #aab7c8; --border: #2b3a50; --accent: #67e8f9; } }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, Arial, sans-serif; background: var(--bg); color: var(--text); }
      main { width: min(1180px, calc(100% - 28px)); margin: 28px auto 60px; }
      h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 48px); line-height: 1; }
      .lead { margin: 0 0 22px; color: var(--muted); font-size: 16px; line-height: 1.55; }
      .summary { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; }
      .pill { border: 1px solid var(--border); border-radius: 999px; padding: 8px 12px; background: color-mix(in srgb, var(--card) 80%, transparent); color: var(--muted); }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
      article { overflow: hidden; border: 1px solid var(--border); border-radius: 22px; background: var(--card); box-shadow: 0 14px 34px rgba(0, 0, 0, 0.08); }
      img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: #d9e3ef; }
      .empty-image { display: grid; place-items: center; width: 100%; aspect-ratio: 16 / 10; background: linear-gradient(135deg, #d9e3ef, #eff6ff); color: #526275; font-weight: 700; }
      .body { padding: 14px; }
      .section { color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
      h2 { margin: 8px 0 8px; font-size: 20px; line-height: 1.15; }
      p { margin: 8px 0; color: var(--muted); line-height: 1.45; }
      code, textarea { font-family: Consolas, monospace; }
      textarea { width: 100%; min-height: 88px; resize: vertical; margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 12px; background: transparent; color: var(--text); font-size: 12px; }
      input[type="text"] { width: 100%; margin-top: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 12px; background: transparent; color: var(--text); }
      .toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin: 0 0 18px; padding: 12px; border: 1px solid var(--border); border-radius: 18px; background: color-mix(in srgb, var(--card) 92%, transparent); backdrop-filter: blur(16px); }
      .button { border: 0; border-radius: 999px; padding: 10px 14px; background: var(--accent); color: white; font-weight: 800; cursor: pointer; }
      .approve-row { display: flex; gap: 8px; align-items: center; margin-top: 12px; color: var(--text); font-weight: 800; }
      .approve-row input { width: 18px; height: 18px; }
      .field-label { display: block; margin-top: 10px; color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
      a { color: var(--accent); }
    </style>
  </head>
  <body>
    <main>
      <h1>Catalog photo moderation</h1>
      <p class="lead">Review candidates manually. Approve only clean, relevant photos without watermarks, third-party labels, or obvious advertising overlays.</p>
      <div class="summary">
        <span class="pill">Updated: ${escapeHtml(report.generatedAt)}</span>
        <span class="pill">Cards: ${cards.length}</span>
        <span class="pill">With candidates: ${withPhotos}</span>
      </div>
      <div class="toolbar">
        <span>Tick clean images, then export approvals.</span>
        <button class="button" type="button" id="exportApprovals">Export approvals JSON</button>
      </div>
      <section class="grid">
        ${cards.map(({ section, item }) => htmlGalleryCard(section, item)).join("\n")}
      </section>
    </main>
    <script>
      const generatedAt = ${JSON.stringify(report.generatedAt)};
      document.querySelector("#exportApprovals")?.addEventListener("click", async () => {
        const items = [...document.querySelectorAll("[data-approval-card]")].map((card) => ({
          section: card.dataset.section,
          id: card.dataset.id,
          title: card.dataset.title,
          approved: Boolean(card.querySelector("[data-approval-check]")?.checked),
          photoCandidateFile: card.querySelector("[data-approval-file]")?.value || "",
          photoSearchQuery: card.dataset.query || "",
          targetFileName: "1",
          note: card.querySelector("[data-approval-note]")?.value || ""
        }));
        const payload = {
          generatedAt: new Date().toISOString(),
          basedOn: generatedAt,
          instructions: [
            "Save this JSON as config/catalog-moderation-approvals.json.",
            "Only approved: true items will be applied.",
            "Run npm run catalog:moderation:apply after saving."
          ],
          items
        };
        const text = JSON.stringify(payload, null, 2) + "\\n";
        try {
          await navigator.clipboard.writeText(text);
          alert("Approvals JSON copied to clipboard.");
        } catch {
          const blob = new Blob([text], { type: "application/json" });
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = "catalog-moderation-approvals.json";
          link.click();
          URL.revokeObjectURL(link.href);
        }
      });
    </script>
  </body>
</html>
`;
}

function htmlGalleryCard(section, item) {
  const candidate = item.photoCandidates[0] || null;
  const src = candidate ? path.relative(MODERATION_ROOT, path.join(ROOT, candidate.file)).replaceAll("\\", "/") : "";
  const approvalSnippet = {
    section: item.section,
    id: item.id,
    title: item.title,
    approved: false,
    photoCandidateFile: candidate?.file || "",
    photoSearchQuery: item.photoSearchQueries?.[0] || "",
    targetFileName: "1",
    note: ""
  };

  return `<article data-approval-card data-section="${escapeHtml(item.section)}" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" data-query="${escapeHtml(item.photoSearchQueries?.[0] || "")}">
    ${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.title)}" loading="lazy" />` : `<div class="empty-image">No candidate</div>`}
    <div class="body">
      <div class="section">${escapeHtml(section.title || section.sectionId)}</div>
      <h2>${escapeHtml(item.title)}</h2>
      ${item.subtitle ? `<p>${escapeHtml(item.subtitle)}</p>` : ""}
      <p>Candidates: ${item.photoCandidates.length}. Sources: ${item.sourceCount}. Top score: ${candidate?.score ?? "n/a"}. ${item.moderationNotes.length ? escapeHtml(item.moderationNotes.join(" ")) : "Ready for review."}</p>
      ${candidate?.scoreReasons?.length ? `<p><b>Why:</b> ${escapeHtml(candidate.scoreReasons.join("; "))}</p>` : ""}
      ${candidate?.riskReasons?.length ? `<p><b>Risks:</b> ${escapeHtml(candidate.riskReasons.join("; "))}</p>` : ""}
      ${item.sourceUrl ? `<p><a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener">Source</a></p>` : ""}
      <label class="approve-row"><input type="checkbox" data-approval-check ${candidate ? "" : "disabled"} /> Approve this photo</label>
      <label class="field-label">Selected file</label>
      <input type="text" data-approval-file value="${escapeHtml(candidate?.file || "")}" readonly />
      <label class="field-label">Moderator note</label>
      <input type="text" data-approval-note placeholder="Optional note" />
      <textarea readonly>${escapeHtml(JSON.stringify(approvalSnippet, null, 2))}</textarea>
    </div>
  </article>`;
}

function isAllowedCandidateImageUrl(url) {
  const normalized = String(url || "").toLowerCase();
  if (!normalized || !/^https?:\/\//i.test(normalized)) return false;
  if (normalized.includes("logo") || normalized.includes("favicon") || normalized.includes("icon")) return false;
  if (normalized.includes("watermark")) return false;
  if (normalized.endsWith(".svg")) return false;
  return true;
}

async function loadPhotoLearning() {
  const local = await readJson(PHOTO_LEARNING_PATH, {});
  const remote = await readRemoteJson("photo:learning", {});
  return {
    local: local && typeof local === "object" ? local : {},
    remote: remote && typeof remote === "object" ? remote : {}
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function countPhotoLearningEntries(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.length;
  if (value.approved || value.rejected) {
    return countPhotoLearningEntries(value.approved) + countPhotoLearningEntries(value.rejected);
  }
  return Object.values(value).reduce((sum, entry) => {
    if (Array.isArray(entry)) return sum + entry.length;
    if (entry && typeof entry === "object") return sum + 1;
    return sum;
  }, 0);
}

function scorePhotoCandidate(candidate) {
  const learning = photoLearning || {};
  const url = String(candidate.url || "");
  const finalUrl = String(candidate.finalUrl || "");
  const urlKey = normalizePhotoUrlKey(finalUrl || url);
  const itemKey = buildLearningItemKey(candidate.sectionId, candidate.item);
  const host = safeHostName(finalUrl || url);
  const lower = safeDecode(`${url} ${finalUrl}`).toLowerCase();
  const dimensions = candidate.dimensions || {};
  const width = Number(dimensions.width || 0);
  const height = Number(dimensions.height || 0);
  const ratio = width && height ? width / height : 0;
  const reasons = [];
  const risks = [];
  let score = 50;

  if (isLearningApproved(learning, itemKey, urlKey)) {
    score += 45;
    reasons.push("manager previously approved this photo");
  }
  if (isLearningRejected(learning, itemKey, urlKey)) {
    score -= 90;
    risks.push("manager previously rejected this photo");
  }
  if (isTrustedPhotoDomain(host, learning)) {
    score += 14;
    reasons.push(`trusted domain: ${host}`);
  }
  if (isBlockedPhotoDomain(finalUrl || url, learning)) {
    score -= 30;
    risks.push(`blocked or risky domain: ${host}`);
  }
  if (candidate.bytes >= 80_000) {
    score += 8;
    reasons.push("good file size");
  }
  if (candidate.bytes < 25_000) {
    score -= 18;
    risks.push("very small file");
  }
  if (width >= 900 && height >= 500) {
    score += 14;
    reasons.push(`${width}x${height}`);
  } else if (width && height) {
    score -= 10;
    risks.push(`small dimensions ${width}x${height}`);
  }
  if (ratio >= 1.35 && ratio <= 2.2) {
    score += 12;
    reasons.push("card-friendly landscape crop");
  } else if (ratio && ratio < 0.85) {
    score -= 15;
    risks.push("vertical image may crop badly");
  }
  if (/(?:watermark|wmark|logo|ticket|tickets|poster|banner|afisha|announce|price|badge|sale|скидк|билет)/iu.test(lower)) {
    score -= 35;
    risks.push("url looks like poster, ticket, logo, or watermark");
  }
  if (/(?:\.svg|favicon|sprite|placeholder|default)/iu.test(lower)) {
    score -= 45;
    risks.push("technical image marker");
  }
  if (/(?:upload|media|photo|image|jpg|jpeg|png|webp)/iu.test(lower)) {
    score += 4;
  }

  const note = learning?.local?.notes?.[itemKey] || learning?.remote?.notes?.[itemKey] || "";
  if (note) reasons.push(`manager note: ${cleanText(note, 80)}`);

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 6),
    risks: risks.slice(0, 6)
  };
}

function isLearningApproved(learning, itemKey, urlKey) {
  return hasLearningUrl(learning?.local?.approved, itemKey, urlKey)
    || hasLearningUrl(learning?.remote?.approved, itemKey, urlKey);
}

function isLearningRejected(learning, itemKey, urlKey) {
  return hasLearningUrl(learning?.local?.rejected, itemKey, urlKey)
    || hasLearningUrl(learning?.remote?.rejected, itemKey, urlKey);
}

function hasLearningUrl(bucket, itemKey, urlKey) {
  if (!bucket || !urlKey) return false;
  const globalEntries = normalizeLearningEntries(bucket.global || bucket._global || []);
  const itemEntries = normalizeLearningEntries(bucket[itemKey] || []);
  return [...globalEntries, ...itemEntries].some((entry) => normalizePhotoUrlKey(entry.url || entry.sourceUrl || entry) === urlKey);
}

function normalizeLearningEntries(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.values(value);
}

function isTrustedPhotoDomain(host, learning) {
  const trusted = [
    ...(learning?.local?.trustedDomains || []),
    ...(learning?.remote?.trustedDomains || [])
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
  return trusted.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isBlockedPhotoDomain(url, learning) {
  const normalized = String(url || "").toLowerCase();
  const blocked = [
    ...(learning?.local?.blockedDomains || []),
    ...(learning?.remote?.blockedDomains || [])
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
  return blocked.some((marker) => normalized.includes(marker));
}

function readImageDimensions(bytes, contentType = "") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return readPngDimensions(bytes);
  if (type.includes("jpeg") || type.includes("jpg")) return readJpegDimensions(bytes);
  if (type.includes("webp")) return readWebpDimensions(bytes);
  return {};
}

function readPngDimensions(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return {};
  return {
    width: readUInt32BE(bytes, 16),
    height: readUInt32BE(bytes, 20)
  };
}

function readJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return {};
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = readUInt16BE(bytes, offset + 2);
    if (length < 2) return {};
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: readUInt16BE(bytes, offset + 5),
        width: readUInt16BE(bytes, offset + 7)
      };
    }
    offset += 2 + length;
  }
  return {};
}

function readWebpDimensions(bytes) {
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (bytes.length < 30 || riff !== "RIFF" || webp !== "WEBP") return {};
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
      height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      width: readUInt16LE(bytes, 26) & 0x3fff,
      height: readUInt16LE(bytes, 28) & 0x3fff
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    };
  }
  return {};
}

function readUInt16BE(bytes, offset) {
  return ((bytes[offset] || 0) << 8) + (bytes[offset + 1] || 0);
}

function readUInt16LE(bytes, offset) {
  return (bytes[offset] || 0) + ((bytes[offset + 1] || 0) << 8);
}

function readUInt32BE(bytes, offset) {
  return ((bytes[offset] || 0) * 0x1000000)
    + ((bytes[offset + 1] || 0) << 16)
    + ((bytes[offset + 2] || 0) << 8)
    + (bytes[offset + 3] || 0);
}

function buildLearningItemKey(sectionId, item) {
  return `${sectionId}:${item?.id || normalizePhotoUrlKey(item?.title || "")}`;
}

function normalizePhotoUrlKey(value) {
  try {
    const url = new URL(String(value || "").trim());
    const proxied = url.searchParams.get("url");
    if (proxied && /\/api\/image\/?$/iu.test(url.pathname)) return normalizePhotoUrlKey(proxied);
    url.hash = "";
    url.searchParams.sort();
    return url.toString().replace(/\/+$/u, "").toLowerCase();
  } catch {
    return cleanText(value || "", 1000).replace(/\/+$/u, "").toLowerCase();
  }
}

function safeHostName(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function extensionFromUrl(url) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension) ? extension : "";
  } catch {
    return "";
  }
}

function parseOptions(args) {
  const valueOf = (name, fallback) => {
    const raw = args.find((arg) => arg.startsWith(`${name}=`));
    return raw ? raw.split("=").slice(1).join("=") : fallback;
  };
  const sections = valueOf("--section", "")
    .split(",")
    .map((section) => section.trim())
    .filter(Boolean);

  return {
    sections,
    missingPhotosOnly: args.includes("--missing-photos-only"),
    limitPerSection: Number(valueOf("--limit-per-section", "0")) || 0,
    maxSourcesPerItem: Number(valueOf("--max-sources-per-item", "3")) || 3,
    maxImagesPerItem: Number(valueOf("--max-images-per-item", "3")) || 3,
    maxImageBytes: Number(valueOf("--max-image-bytes", "6000000")) || 6000000
  };
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function uniqueByUrl(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = entry.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sectionLabel(sectionId) {
  return {
    parks: "Parks",
    sights: "Sights",
    hotels: "Hotels",
    excursions: "Excursions",
    food: "Food",
    routes: "Walking routes",
    active: "Active leisure",
    masterclasses: "Masterclasses",
    roadtrip: "By car"
  }[sectionId] || sectionId;
}

function escapeMarkdown(value) {
  return String(value || "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
