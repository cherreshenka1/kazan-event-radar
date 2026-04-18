import { CATALOG } from "../src/data/catalog.js";
import { cleanText, fetchPageSnapshot, pickPrimarySnapshot, projectPath, readJson, toSlug, writeJson } from "./lib/catalog-import-utils.mjs";
import { buildCatalogImportOverrides } from "./lib/catalog-import-overrides-builder.mjs";

const generatedAt = new Date().toISOString();
const sectionId = "food";

const catalogSources = readJson(projectPath("config", "catalog-sources.json"));
const itemManifest = readJson(projectPath("config", "catalog-food-items.json"));

const sectionConfig = catalogSources.sections?.[sectionId];
if (!sectionConfig) {
  throw new Error(`Section config "${sectionId}" not found in config/catalog-sources.json`);
}

const foodSection = CATALOG.food;
if (!foodSection?.items?.length) {
  throw new Error("Food section is empty in src/data/catalog.js");
}

const manifestById = new Map((itemManifest.items || []).map((item) => [item.id, item]));
const missingManifestIds = [];
const rawSummary = [];
const normalizedItems = [];

for (const item of foodSection.items) {
  const manifestEntry = manifestById.get(item.id);
  if (!manifestEntry) missingManifestIds.push(item.id);

  const sourceRefs = {
    officialSite: manifestEntry?.officialUrl || "",
    cityGuide: manifestEntry?.cityGuideUrl || "",
    guide: manifestEntry?.guideUrl || "",
    map: item.mapUrl || "",
    reviews: item.reviewUrl || ""
  };

  const externalSources = Object.entries({
    officialSite: sourceRefs.officialSite,
    cityGuide: sourceRefs.cityGuide,
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
    imageUrl: primarySnapshot?.image || item.imageUrl || "",
    sourceUrl: sourceRefs.officialSite || sourceRefs.cityGuide || sourceRefs.guide || item.sourceUrl || "",
    sourceRefs,
    externalPreviewUrl: primarySnapshot?.image || "",
    externalTitle: primarySnapshot?.h1 || primarySnapshot?.title || "",
    externalSummary: primarySnapshot?.description || "",
    importMeta: {
      generatedAt,
      sourceSeed: "src/data/catalog.js",
      sourceManifest: "config/catalog-food-items.json",
      sourcePriority: ["officialSite", "cityGuide", "guide", "map", "reviews"],
      notes: manifestEntry?.notes || "",
      completeness: {
        hasOfficialSite: Boolean(sourceRefs.officialSite),
        hasCityGuide: Boolean(sourceRefs.cityGuide),
        hasGuide: Boolean(sourceRefs.guide),
        hasMap: Boolean(sourceRefs.map),
        hasReviews: Boolean(sourceRefs.reviews)
      }
    },
    qualitySignals: {
      hasSignatureDishes: Array.isArray(item.signatureDishes) && item.signatureDishes.length > 0,
      hasInterior: Boolean(cleanText(item.interior, 120)),
      hasReviewSummary: Boolean(cleanText(item.reviewSummary, 120)),
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
    title: foodSection.title,
    intro: foodSection.intro,
    itemCount: normalizedItems.length,
    items: normalizedItems
  }
);

const buildResult = buildCatalogImportOverrides();

console.log(`Food items normalized: ${normalizedItems.length}`);
console.log(`Raw source snapshots saved: ${rawSummary.length}`);
console.log(`Override sections rebuilt: ${buildResult.sectionCount}`);

if (missingManifestIds.length) {
  console.log(`Items missing manifest entries: ${missingManifestIds.join(", ")}`);
} else {
  console.log("All food items have manifest entries.");
}
