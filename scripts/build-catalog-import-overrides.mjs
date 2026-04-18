import { buildCatalogImportOverrides } from "./lib/catalog-import-overrides-builder.mjs";

const result = buildCatalogImportOverrides();

console.log(`Catalog import override file updated: ${result.generatedPath}`);
console.log(`Sections with overrides: ${result.sectionCount}`);
