import fs from "node:fs/promises";

export async function fetchSocialExport(source) {
  if (!source.path) {
    return [];
  }

  const raw = await fs.readFile(source.path, "utf8");
  const rows = JSON.parse(raw);

  return rows.map((item) => ({
    sourceId: source.id,
    sourceName: source.name,
    type: source.platform || "social_export",
    title: item.title || item.caption?.split("\n").find(Boolean) || source.name,
    summary: item.summary || item.caption,
    url: item.url,
    publishedAt: item.publishedAt || item.createdAt,
    categories: source.categories || []
  }));
}
