import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CITY_CONFIG_PATH = "config/cities.json";
const FALLBACK_CITY = {
  id: "kazan",
  name: "Казань",
  country: "Россия",
  locale: "ru-RU",
  timezone: "Europe/Moscow",
  slug: "kazan",
  brandName: "Kazan Event Radar",
  telegramBotUsername: "kazanEventRadarBot",
  coordinates: {
    lat: 55.796127,
    lon: 49.106405
  },
  aliases: ["Kazan", "Казань", "kazan"],
  sourceHints: {
    yandexAfishaPath: "/kazan",
    mtsLivePath: "/kazan",
    kassirCitySlug: "kazan"
  }
};

export async function loadCityRegistry(configPath = process.env.CITIES_CONFIG_PATH || DEFAULT_CITY_CONFIG_PATH) {
  const absolutePath = path.resolve(process.cwd(), configPath);

  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    const registry = JSON.parse(raw);

    return {
      defaultCityId: registry.defaultCityId || FALLBACK_CITY.id,
      cities: Array.isArray(registry.cities) && registry.cities.length > 0
        ? registry.cities
        : [FALLBACK_CITY]
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        defaultCityId: FALLBACK_CITY.id,
        cities: [FALLBACK_CITY]
      };
    }

    throw error;
  }
}

export async function loadCityConfig(cityRef = process.env.CITY_ID || process.env.EVENT_CITY_ID) {
  const registry = await loadCityRegistry();
  const requestedCity = findCity(registry.cities, cityRef);
  const defaultCity = findCity(registry.cities, registry.defaultCityId);

  return normalizeCityConfig(requestedCity || defaultCity || FALLBACK_CITY);
}

function findCity(cities, cityRef) {
  const normalizedRef = normalizeToken(cityRef);
  if (!normalizedRef) return null;

  return cities.find((city) => {
    const tokens = [
      city.id,
      city.slug,
      city.name,
      ...(Array.isArray(city.aliases) ? city.aliases : [])
    ];

    return tokens.some((token) => normalizeToken(token) === normalizedRef);
  }) || null;
}

function normalizeCityConfig(city) {
  return {
    ...FALLBACK_CITY,
    ...city,
    coordinates: {
      ...FALLBACK_CITY.coordinates,
      ...(city.coordinates || {})
    },
    sourceHints: {
      ...FALLBACK_CITY.sourceHints,
      ...(city.sourceHints || {})
    },
    aliases: Array.isArray(city.aliases) ? city.aliases : FALLBACK_CITY.aliases
  };
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}
