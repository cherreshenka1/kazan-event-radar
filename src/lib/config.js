import fs from "node:fs/promises";
import path from "node:path";
import { loadCityConfig } from "./cityConfig.js";

export async function loadSourceConfig(configPath = process.env.SOURCE_CONFIG_PATH || "config/sources.json") {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const config = JSON.parse(raw);
  const cityConfig = await loadCityConfig(config.cityId || config.citySlug || config.city);
  const directorySources = await loadSourceDirectory();
  const sources = [
    ...(Array.isArray(config.sources) ? config.sources : []),
    ...directorySources
  ];

  return {
    cityId: cityConfig.id,
    city: config.city || cityConfig.name,
    citySlug: cityConfig.slug,
    country: cityConfig.country,
    locale: config.locale || cityConfig.locale,
    timezone: config.timezone || cityConfig.timezone,
    brandName: cityConfig.brandName,
    coordinates: cityConfig.coordinates,
    sourceHints: cityConfig.sourceHints,
    sources: dedupeSources(sources).filter((source) => source.enabled !== false)
  };
}

export function getDataDir() {
  return path.resolve(process.cwd(), process.env.DATA_DIR || "data");
}

export async function loadTicketPlatforms(configPath = process.env.TICKET_PLATFORMS_PATH || "config/ticket-platforms.json") {
  const absolutePath = path.resolve(process.cwd(), configPath);

  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    const config = JSON.parse(raw);
    return Array.isArray(config.platforms) ? config.platforms.filter((platform) => platform.enabled !== false) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function loadSourceDirectory(configPath = process.env.SOURCE_DIRECTORY_PATH || "config/source-directory.json") {
  const absolutePath = path.resolve(process.cwd(), configPath);

  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    const directory = JSON.parse(raw);
    return [
      ...(directory.telegramChannels || []).map((source) => ({ ...source, type: "telegram_public_channel" })),
      ...(directory.rssFeeds || []).map((source) => ({ ...source, type: "rss" })),
      ...(directory.webPages || []).map((source) => ({ ...source, type: "html" })),
      ...(directory.socialAccounts || [])
    ];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function dedupeSources(sources) {
  const byId = new Map();

  for (const source of sources) {
    byId.set(source.id, {
      ...byId.get(source.id),
      ...source
    });
  }

  return [...byId.values()];
}
