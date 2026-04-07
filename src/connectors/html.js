import * as cheerio from "cheerio";
import { fetchText } from "../lib/fetch.js";

export async function fetchHtmlSource(source) {
  const html = await fetchText(source.url);
  const $ = cheerio.load(html);
  const selectors = source.selectors || {};
  const itemSelector = selectors.item || "article";

  return $(itemSelector).toArray().map((element) => {
    const root = $(element);
    const link = root.find(selectors.url || "a").first();
    const href = link.attr("href");

    return {
      sourceId: source.id,
      sourceName: source.name,
      type: "html",
      title: root.find(selectors.title || "h1,h2,h3,a").first().text().trim(),
      summary: root.find(selectors.summary || "p").first().text().trim(),
      url: href ? new URL(href, source.url).toString() : source.url,
      publishedAt: root.find(selectors.date || "time").first().attr("datetime") || root.find(selectors.date || "time").first().text().trim(),
      categories: source.categories || []
    };
  }).filter((item) => item.title || item.summary);
}
