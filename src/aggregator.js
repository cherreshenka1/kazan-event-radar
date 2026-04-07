import pino from "pino";
import { loadSourceConfig } from "./lib/config.js";
import { classifyItem } from "./lib/classifier.js";
import { JsonStore } from "./storage/jsonStore.js";
import { fetchRssSource } from "./connectors/rss.js";
import { fetchHtmlSource } from "./connectors/html.js";
import { fetchTelegramPublicChannel } from "./connectors/telegramPublic.js";
import { fetchSocialExport } from "./connectors/socialExport.js";

const logger = pino({ name: "kazan-event-radar" });

const CONNECTORS = {
  rss: fetchRssSource,
  html: fetchHtmlSource,
  telegram_public_channel: fetchTelegramPublicChannel,
  social_export: fetchSocialExport
};

export async function scanSources() {
  const config = await loadSourceConfig();
  const store = new JsonStore();
  const collected = [];

  for (const source of config.sources) {
    const connector = CONNECTORS[source.type];

    if (!connector) {
      logger.warn({ sourceId: source.id, type: source.type }, "Unsupported source type");
      continue;
    }

    try {
      const items = await connector(source);
      collected.push(...items.map(classifyItem));
      logger.info({ sourceId: source.id, count: items.length }, "Source scanned");
    } catch (error) {
      logger.warn({ sourceId: source.id, error: error.message }, "Source scan failed");
    }
  }

  return store.upsertItems(collected);
}

export async function loadItems() {
  return new JsonStore().loadItems();
}
