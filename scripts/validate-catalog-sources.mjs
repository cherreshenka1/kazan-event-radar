import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const filePath = path.join(root, "config", "catalog-sources.json");

const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
const sections = payload.sections || {};
const errors = [];
const warnings = [];
const seenSourceIds = new Set();

for (const [sectionId, section] of Object.entries(sections)) {
  if (!section.label) errors.push(`Section "${sectionId}" has no label.`);
  if (!section.rawDir) errors.push(`Section "${sectionId}" has no rawDir.`);
  if (!section.normalizedFile) errors.push(`Section "${sectionId}" has no normalizedFile.`);
  if (!Array.isArray(section.sources) || !section.sources.length) {
    errors.push(`Section "${sectionId}" has no sources.`);
    continue;
  }

  for (const source of section.sources) {
    if (!source.id) errors.push(`Section "${sectionId}" contains a source without id.`);
    if (!source.name) errors.push(`Section "${sectionId}" source "${source.id || "unknown"}" has no name.`);
    if (!source.type) errors.push(`Section "${sectionId}" source "${source.id || "unknown"}" has no type.`);
    if (!Array.isArray(source.fields) || !source.fields.length) {
      warnings.push(`Section "${sectionId}" source "${source.id || "unknown"}" has no fields list.`);
    }

    if (source.id) {
      if (seenSourceIds.has(source.id)) {
        errors.push(`Duplicate source id detected: "${source.id}".`);
      }
      seenSourceIds.add(source.id);
    }

    if (source.enabled && source.url === "") {
      warnings.push(`Section "${sectionId}" source "${source.id}" is enabled but url is empty.`);
    }
  }
}

console.log(`Catalog sections: ${Object.keys(sections).length}`);

for (const [sectionId, section] of Object.entries(sections)) {
  console.log(`- ${sectionId}: ${section.sources.length} sources, refresh every ${section.refreshDays} day(s)`);
}

if (warnings.length) {
  console.log("\nWarnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (errors.length) {
  console.error("\nErrors:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("\nCatalog source map is valid.");
}
