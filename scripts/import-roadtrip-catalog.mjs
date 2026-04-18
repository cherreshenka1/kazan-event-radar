import { CATALOG } from "../src/data/catalog.js";
import { buildCatalogImportOverrides } from "./lib/catalog-import-overrides-builder.mjs";
import { fetchPageSnapshot, pickPrimarySnapshot, projectPath, readJson, toSlug, writeJson } from "./lib/catalog-import-utils.mjs";

const generatedAt = new Date().toISOString();
const sectionId = "roadtrip";

const catalogSources = readJson(projectPath("config", "catalog-sources.json"));
const itemManifest = readJson(projectPath("config", "catalog-roadtrip-items.json"));

const sectionConfig = catalogSources.sections?.[sectionId];
if (!sectionConfig) {
  throw new Error(`Section config "${sectionId}" not found in config/catalog-sources.json`);
}

const section = CATALOG.roadtrip;
if (!section?.items?.length) {
  throw new Error("Roadtrip section is empty in src/data/catalog.js");
}

const manifestById = new Map((itemManifest.items || []).map((item) => [item.id, item]));
const missingManifestIds = [];
const rawSummary = [];
const normalizedItems = [];

for (const item of section.items) {
  const manifestEntry = manifestById.get(item.id);
  if (!manifestEntry) missingManifestIds.push(item.id);

  const sourceRefs = {
    officialSite: manifestEntry?.officialUrl || "",
    guide: manifestEntry?.guideUrl || "",
    map: item.mapUrl || ""
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
    imageUrl: primarySnapshot?.image || item.imageUrl || "",
    sourceUrl: sourceRefs.officialSite || sourceRefs.guide || item.sourceUrl || "",
    sourceRefs,
    externalPreviewUrl: primarySnapshot?.image || "",
    externalTitle: primarySnapshot?.h1 || primarySnapshot?.title || "",
    externalSummary: primarySnapshot?.description || "",
    transportOptions: [
      "На машине удобнее всего",
      "Такси подходит для части направлений",
      "Для некоторых точек есть автобусы или экскурсии"
    ],
    importMeta: {
      generatedAt,
      sourceSeed: "src/data/catalog.js",
      sourceManifest: "config/catalog-roadtrip-items.json",
      sourcePriority: ["officialSite", "guide", "map"],
      notes: manifestEntry?.notes || "",
      completeness: {
        hasOfficialSite: Boolean(sourceRefs.officialSite),
        hasGuide: Boolean(sourceRefs.guide),
        hasMap: Boolean(sourceRefs.map)
      }
    },
    qualitySignals: {
      hasHighlights: Array.isArray(item.highlights) && item.highlights.length > 0,
      hasBestFor: Boolean(item.bestFor),
      hasTiming: Boolean(item.timing),
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

console.log(`Roadtrip items normalized: ${normalizedItems.length}`);
console.log(`Raw source snapshots saved: ${rawSummary.length}`);
console.log(`Override sections rebuilt: ${buildResult.sectionCount}`);

if (missingManifestIds.length) {
  console.log(`Items missing manifest entries: ${missingManifestIds.join(", ")}`);
} else {
  console.log("All roadtrip items have manifest entries.");
}
