import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../src/data/catalog.js";
import { cleanText, fetchPageSnapshot, projectPath } from "./lib/catalog-import-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const MODERATION_ROOT = projectPath("data", "catalog-moderation");
const PHOTO_CANDIDATES_ROOT = path.join(MODERATION_ROOT, "photo-candidates");
const REPORT_JSON = path.join(MODERATION_ROOT, "review-board.json");
const REPORT_MD = path.join(MODERATION_ROOT, "review-board.md");
const APPROVALS_TEMPLATE = path.join(MODERATION_ROOT, "approvals.template.json");
const SECTION_ORDER = ["parks", "sights", "hotels", "excursions", "food", "routes", "active", "masterclasses", "roadtrip"];
const IMAGE_EXTENSIONS_BY_TYPE = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

const options = parseOptions(process.argv.slice(2));

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(PHOTO_CANDIDATES_ROOT, { recursive: true });

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
    const section = CATALOG[sectionId];
    if (!Array.isArray(section?.items)) continue;

    const limit = options.limitPerSection || section.items.length;
    const items = [];

    for (const item of section.items.slice(0, limit)) {
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
  await fs.writeFile(APPROVALS_TEMPLATE, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");

  console.log(`Catalog moderation board: ${path.relative(ROOT, REPORT_MD)}`);
  console.log(`Approvals template: ${path.relative(ROOT, APPROVALS_TEMPLATE)}`);
  console.log(`Photo candidates: ${path.relative(ROOT, PHOTO_CANDIDATES_ROOT)}`);
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

  const imageUrls = unique([
    item.externalPreviewUrl,
    item.imageUrl,
    ...snapshots.map((snapshot) => snapshot.image),
    ...(Array.isArray(item.photoLinks) ? item.photoLinks.map((link) => link.url).filter((url) => /^https?:\/\//i.test(url || "")) : [])
  ]).filter(isAllowedCandidateImageUrl);

  const photoCandidates = [];
  let index = 1;

  for (const url of imageUrls.slice(0, options.maxImagesPerItem)) {
    const downloaded = await downloadImageCandidate(sectionId, item.id, url, index);
    if (downloaded) {
      photoCandidates.push(downloaded);
      index += 1;
    }
  }

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
    photoSearchQueries: buildPhotoSearchQueries(sectionId, item, snapshots),
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

async function downloadImageCandidate(sectionId, itemId, url, index) {
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
      downloadedAt: new Date().toISOString(),
      moderation: "Approve only if there is no watermark, no foreign service branding, and the image is relevant."
    }, null, 2)}\n`, "utf8");

    return {
      file: path.relative(ROOT, filePath).replaceAll("\\", "/"),
      sourceUrl: url,
      bytes: bytes.byteLength,
      contentType
    };
  } catch {
    return null;
  }
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
  if (!item.sourceUrl && !snapshots.some((snapshot) => snapshot.ok)) notes.push("No reliable source attached.");
  if (sectionId === "food" && !item.reviewSummary) notes.push("Restaurant card should include a short review-based summary.");
  if (sectionId === "roadtrip" && !item.howToGet) notes.push("Roadtrip card needs clearer logistics.");
  return notes;
}

function buildPhotoSearchQueries(sectionId, item, snapshots) {
  const title = cleanText(item.title || item.subtitle || sectionLabel(sectionId), 80);
  const venueOrType = cleanText(item.venueTitle || item.category || sectionLabel(sectionId), 80);
  const snapshotTitle = cleanText(snapshots.find((snapshot) => snapshot.title)?.title || "", 80);

  return unique([
    `${title} Казань фото`,
    `${title} ${venueOrType} Казань`,
    snapshotTitle ? `${snapshotTitle} Казань фото` : "",
    sectionId === "masterclasses" ? `${title} мастер-класс Казань фото` : "",
    sectionId === "food" ? `${title} ресторан Казань интерьер блюда` : "",
    sectionId === "active" ? `${title} активный отдых Казань фото` : ""
  ]).slice(0, 4);
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
      lines.push(`| ${escapeMarkdown(item.title)} | ${item.photoCandidates.length} | ${item.sourceCount} | ${escapeMarkdown(searchHint)} | ${escapeMarkdown(item.moderationNotes.join("; ") || "ready for review")} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function isAllowedCandidateImageUrl(url) {
  const normalized = String(url || "").toLowerCase();
  if (!normalized || !/^https?:\/\//i.test(normalized)) return false;
  if (normalized.includes("logo") || normalized.includes("favicon") || normalized.includes("icon")) return false;
  if (normalized.includes("watermark")) return false;
  if (normalized.endsWith(".svg")) return false;
  return true;
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

  return {
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
