import fs from "node:fs";
import path from "node:path";

import { projectPath, readJson } from "./catalog-import-utils.mjs";

export function buildCatalogImportOverrides() {
  const normalizedDir = projectPath("data", "catalog-imports", "normalized");
  const generatedPath = projectPath("src", "data", "catalog-imports.generated.js");

  const overrides = {};

  if (fs.existsSync(normalizedDir)) {
    for (const entry of fs.readdirSync(normalizedDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      const filePath = path.join(normalizedDir, entry.name);
      const payload = readJson(filePath);
      const sectionId = payload.section || entry.name.replace(/\.json$/i, "");
      if (!sectionId) continue;

      overrides[sectionId] = {
        title: payload.title,
        intro: payload.intro,
        levels: payload.levels,
        items: payload.items
      };
    }
  }

  const contents = [
    "// This file is generated automatically by catalog import scripts.",
    `export const CATALOG_IMPORT_OVERRIDES = ${JSON.stringify(overrides, null, 2)};`,
    ""
  ].join("\n");

  fs.writeFileSync(generatedPath, contents, "utf8");
  return { generatedPath, sectionCount: Object.keys(overrides).length, overrides };
}
