import express from "express";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, MAIN_SECTIONS, getItem, getRoute } from "../data/catalog.js";
import { loadItems } from "../aggregator.js";
import { isWithinDays } from "../lib/dates.js";
import { UserStore } from "../storage/userStore.js";
import { optionalTelegramAuth, telegramAuth } from "./auth.js";
import { attachTicketLinks } from "../lib/tickets.js";
import { analyticsStore } from "../storage/analyticsStore.js";
import { registerAdminRoutes } from "./admin.js";
import { getAllowedEventWindowLabel, isAllowedEventItem } from "../lib/eventFilter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

export function createServer() {
  const app = express();
  const userStore = new UserStore();

  app.use(helmet({
    contentSecurityPolicy: false
  }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "kazan-event-radar" });
  });

  app.get("/api/config", optionalTelegramAuth, (req, res) => {
    res.json({
      user: req.telegramUser,
      miniAppUrl: process.env.MINI_APP_URL || null,
      channelUrl: process.env.TELEGRAM_CHANNEL_URL || null
    });
  });

  app.post("/api/analytics/track", optionalTelegramAuth, async (req, res) => {
    await analyticsStore.track({
      type: "miniapp",
      action: req.body?.action || "unknown",
      label: req.body?.label,
      source: "miniapp",
      userId: req.telegramUser?.id,
      metadata: req.body?.metadata || {}
    });
    res.json({ ok: true });
  });

  app.get("/api/catalog", (_req, res) => {
    res.json({
      sections: MAIN_SECTIONS,
      catalog: CATALOG
    });
  });

  app.get("/api/events", async (req, res) => {
    const period = req.query.period || "week";
    const days = period === "today" ? 1 : 7;
    const items = (await loadItems())
      .filter((item) => item.categories?.includes("events") || item.type === "telegram_public_channel")
      .filter((item) => period === "april" || period === "month" ? isAllowedEventItem(item) : isWithinDays(item, days))
      .slice()
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, Number(req.query.limit || 60));

    res.json({
      period,
      periodLabel: period === "april" || period === "month" ? getAllowedEventWindowLabel() : null,
      items: await Promise.all(items.map(attachTicketLinks))
    });
  });

  app.get("/api/favorites", telegramAuth, async (req, res) => {
    res.json({ favorites: await userStore.listFavorites(req.telegramUser.id) });
  });

  app.post("/api/favorites/toggle", telegramAuth, async (req, res) => {
    const favorite = normalizeFavorite(req.body);
    const result = await userStore.toggleFavorite(req.telegramUser.id, favorite);
    res.json(result);
  });

  app.post("/api/reminders/events/:eventId", telegramAuth, async (req, res) => {
    const items = await loadItems();
    const event = items.find((item) => item.id === req.params.eventId);

    if (!event) {
      return res.status(404).json({ error: "Event not found." });
    }

    const result = await userStore.addEventReminders(req.telegramUser.id, event);
    return res.json(result);
  });

  app.get("/api/reminders", telegramAuth, async (req, res) => {
    const user = await userStore.getUser(req.telegramUser.id);
    res.json({ reminders: user.reminders || [] });
  });

  app.use("/miniapp", express.static(path.join(projectRoot, "public", "miniapp")));
  app.use("/assets", express.static(path.join(projectRoot, "assets")));

  registerAdminRoutes(app);

  app.get("/", (_req, res) => {
    res.redirect("/miniapp/");
  });

  app.use((error, _req, res, _next) => {
    res.status(400).json({ error: error.message || "Bad request." });
  });

  return app;
}

export async function startServer() {
  const port = Number(process.env.PORT || 3000);
  const app = createServer();

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Mini App server is running on http://localhost:${port}`);
      resolve(server);
    });
  });
}

function normalizeFavorite(body) {
  if (!body?.type || !body?.id || !body?.title) {
    throw new Error("Favorite requires type, id and title.");
  }

  const favorite = {
    type: body.type,
    id: String(body.id),
    title: body.title,
    subtitle: body.subtitle,
    url: body.url,
    mapUrl: body.mapUrl,
    eventDate: body.eventDate,
    sourceName: body.sourceName
  };

  if (body.type === "catalog") {
    const item = getItem(body.sectionId, body.itemId);
    Object.assign(favorite, {
      sectionId: body.sectionId,
      itemId: body.itemId,
      title: item?.title || favorite.title,
      subtitle: item?.subtitle || favorite.subtitle,
      mapUrl: item?.mapUrl || favorite.mapUrl,
      url: item?.sourceUrl || favorite.url
    });
  }

  if (body.type === "route") {
    const route = getRoute(body.itemId);
    Object.assign(favorite, {
      itemId: body.itemId,
      title: route?.title || favorite.title,
      subtitle: route?.subtitle || favorite.subtitle,
      mapUrl: route?.mapUrl || favorite.mapUrl,
      url: route?.sourceUrl || favorite.url
    });
  }

  return favorite;
}
