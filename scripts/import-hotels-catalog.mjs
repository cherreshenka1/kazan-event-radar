import { CATALOG } from "../src/data/catalog.js";
import { buildCatalogImportOverrides } from "./lib/catalog-import-overrides-builder.mjs";
import { fetchPageSnapshot, pickPrimarySnapshot, projectPath, readJson, toSlug, writeJson } from "./lib/catalog-import-utils.mjs";

const generatedAt = new Date().toISOString();
const sectionId = "hotels";

const catalogSources = readJson(projectPath("config", "catalog-sources.json"));
const itemManifest = readJson(projectPath("config", "catalog-hotels-items.json"));

const sectionConfig = catalogSources.sections?.[sectionId];
if (!sectionConfig) {
  throw new Error(`Section config "${sectionId}" not found in config/catalog-sources.json`);
}

const section = CATALOG.hotels;
if (!section?.items?.length) {
  throw new Error("Hotels section is empty in src/data/catalog.js");
}

const manifestById = new Map((itemManifest.items || []).map((item) => [item.id, item]));
const missingManifestIds = [];
const rawSummary = [];
const normalizedItems = [];

for (const item of section.items) {
  const manifestEntry = manifestById.get(item.id);
  if (!manifestEntry) missingManifestIds.push(item.id);

  const reviewUrl = buildMapsSearchUrl(`${item.title} Казань отзывы`);
  const sourceRefs = {
    officialSite: manifestEntry?.officialUrl || "",
    guide: manifestEntry?.guideUrl || "",
    booking: manifestEntry?.bookingUrl || manifestEntry?.officialUrl || "",
    map: item.mapUrl || "",
    reviews: reviewUrl
  };

  const externalSources = Object.entries({
    officialSite: sourceRefs.officialSite,
    guide: sourceRefs.guide
  }).filter(([, url]) => url);

  const snapshots = [];

  for (const [sourceType, url] of externalSources) {
    const snapshot = await fetchPageSnapshot(url);
    snapshots.push({ sourceType, ...snapshot });
    rawSummary.push({
      itemId: item.id,
      sourceType,
      ...snapshot
    });

    writeJson(
      projectPath("data", "catalog-imports", "raw", sectionId, `${item.id}--${toSlug(sourceType)}.json`),
      {
        itemId: item.id,
        section: sectionId,
        sourceType,
        snapshot
      }
    );
  }

  const primarySnapshot = pickPrimarySnapshot(snapshots);

  normalizedItems.push({
    ...item,
    district: item.district || item.subtitle || "",
    features: Array.isArray(item.features) && item.features.length ? item.features : (item.highlights || []),
    bookingUrl: sourceRefs.booking,
    reviewUrl,
    reviewSource: "Яндекс",
    imageUrl: primarySnapshot?.image || item.imageUrl || "",
    sourceUrl: sourceRefs.officialSite || sourceRefs.guide || item.sourceUrl || "",
    sourceRefs,
    externalPreviewUrl: primarySnapshot?.image || "",
    externalTitle: primarySnapshot?.h1 || primarySnapshot?.title || "",
    externalSummary: primarySnapshot?.description || "",
    importMeta: {
      generatedAt,
      sourceSeed: "src/data/catalog.js",
      sourceManifest: "config/catalog-hotels-items.json",
      sourcePriority: ["officialSite", "guide", "booking", "map", "reviews"],
      notes: manifestEntry?.notes || "",
      completeness: {
        hasOfficialSite: Boolean(sourceRefs.officialSite),
        hasGuide: Boolean(sourceRefs.guide),
        hasBooking: Boolean(sourceRefs.booking),
        hasMap: Boolean(sourceRefs.map),
        hasReviews: Boolean(sourceRefs.reviews)
      }
    },
    qualitySignals: {
      hasHighlights: Array.isArray(item.highlights) && item.highlights.length > 0,
      hasHowToGet: Boolean(item.howToGet),
      hasBookingUrl: Boolean(sourceRefs.booking),
      hasPhotoLinks: Array.isArray(item.photoLinks) && item.photoLinks.length > 0
    }
  });
}

writeJson(
  projectPath("data", "catalog-imports", "raw", sectionId, "_index.json"),
  {
    generatedAt,
    section: sectionId,
    configuredSources: sectionConfig.sources,
    snapshots: rawSummary
  }
);

writeJson(
  projectPath("data", "catalog-imports", "normalized", `${sectionId}.json`),
  {
    generatedAt,
    section: sectionId,
    title: section.title,
    intro: section.intro,
    itemCount: normalizedItems.length,
    items: normalizedItems
  }
);

const buildResult = buildCatalogImportOverrides();

console.log(`Hotel items normalized: ${normalizedItems.length}`);
console.log(`Raw source snapshots saved: ${rawSummary.length}`);
console.log(`Override sections rebuilt: ${buildResult.sectionCount}`);

if (missingManifestIds.length) {
  console.log(`Items missing manifest entries: ${missingManifestIds.join(", ")}`);
} else {
  console.log("All hotel items have manifest entries.");
}

function buildMapsSearchUrl(query) {
  return `https://yandex.ru/maps/?mode=search&text=${encodeURIComponent(query)}`;
}
