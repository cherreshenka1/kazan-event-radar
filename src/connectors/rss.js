import Parser from "rss-parser";

const parser = new Parser();

export async function fetchRssSource(source) {
  const feed = await parser.parseURL(source.url);
  return (feed.items || []).map((item) => ({
    sourceId: source.id,
    sourceName: source.name,
    type: "rss",
    title: item.title,
    summary: item.contentSnippet || item.content || item.summary,
    url: item.link,
    publishedAt: item.isoDate || item.pubDate,
    categories: source.categories || []
  }));
}
