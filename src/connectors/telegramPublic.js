import * as cheerio from "cheerio";
import { fetchText } from "../lib/fetch.js";

export async function fetchTelegramPublicChannel(source) {
  const channel = source.channel.replace(/^@/, "");
  const url = `https://t.me/s/${channel}`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  return $(".tgme_widget_message").toArray().map((element) => {
    const root = $(element);
    const postUrl = root.find(".tgme_widget_message_date").attr("href") || url;

    return {
      sourceId: source.id,
      sourceName: source.name,
      type: "telegram_public_channel",
      title: firstLine(root.find(".tgme_widget_message_text").text()) || source.name,
      summary: root.find(".tgme_widget_message_text").text().trim(),
      url: postUrl,
      publishedAt: root.find("time").attr("datetime"),
      categories: source.categories || []
    };
  }).filter((item) => item.summary);
}

function firstLine(text) {
  return String(text).split("\n").map((line) => line.trim()).find(Boolean);
}
