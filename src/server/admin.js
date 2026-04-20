import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAdminDashboard } from "../lib/adminDashboard.js";
import { analyticsStore } from "../storage/analyticsStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

export function registerAdminRoutes(app) {
  app.get("/admin/analytics", requireAdminAuth, async (_req, res) => {
    res.type("html").send(renderAdminDashboard(await buildAdminSummary()));
  });

  app.get("/admin/analytics.json", requireAdminAuth, async (_req, res) => {
    res.json(await buildAdminSummary());
  });
}

export function requireAdminAuth(req, res, next) {
  const expectedUser = process.env.ANALYTICS_USERNAME || "admin";
  const expectedPassword = process.env.ANALYTICS_PASSWORD;

  if (!expectedPassword) {
    return res.status(503).send("ANALYTICS_PASSWORD is not configured.");
  }

  const header = req.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    return requestAuth(res);
  }

  const [user, password] = Buffer.from(encoded, "base64").toString("utf8").split(":");

  if (user !== expectedUser || password !== expectedPassword) {
    return requestAuth(res);
  }

  return next();
}

function requestAuth(res) {
  res.set("WWW-Authenticate", "Basic realm=\"Kazan Event Radar Analytics\"");
  return res.status(401).send("Authentication required.");
}

async function buildAdminSummary() {
  const analytics = await analyticsStore.summary();
  const [eventsRefresh, catalogRefresh, eventMeta] = await Promise.all([
    readJson(path.join(ROOT, "data", "playwright", "refresh-report.json"), null),
    readJson(path.join(ROOT, "data", "catalog-imports", "refresh-report.json"), null),
    readLocalEventMeta()
  ]);

  return {
    ...analytics,
    system: {
      updatedAt: new Date().toISOString(),
      eventMeta,
      eventsRefresh,
      catalogRefresh
    }
  };
}

async function readLocalEventMeta() {
  const snapshotFiles = [
    path.join(ROOT, "data", "playwright", "yandex-browser-events.json"),
    path.join(ROOT, "data", "playwright", "mts-live-events.json"),
    path.join(ROOT, "data", "playwright", "kassir-browser-events.json"),
    path.join(ROOT, "data", "playwright", "official-sport-events.json")
  ];

  const snapshots = (await Promise.all(snapshotFiles.map((filePath) => readJson(filePath, null))))
    .filter(Boolean);

  if (snapshots.length === 0) {
    return null;
  }

  const sourceMap = new Map();
  let lastScanAt = null;
  let collectedItems = 0;

  for (const snapshot of snapshots) {
    const syncedAt = snapshot.syncedAt || null;
    if (syncedAt && (!lastScanAt || new Date(syncedAt).getTime() > new Date(lastScanAt).getTime())) {
      lastScanAt = syncedAt;
    }

    const itemCount = Array.isArray(snapshot.items) ? snapshot.items.length : 0;
    collectedItems += itemCount;

    for (const source of Array.isArray(snapshot.sourceStats) ? snapshot.sourceStats : []) {
      const sourceId = source.id || source.name || `source-${sourceMap.size + 1}`;
      sourceMap.set(sourceId, {
        id: source.id || sourceId,
        name: source.name || source.id || sourceId,
        importedItems: Number(source.importedItems || 0),
        collectedLinks: Number(source.collectedLinks || 0),
        queuedLinks: Number(source.queuedLinks || 0)
      });
    }
  }

  return {
    lastScanAt,
    reason: "local_snapshot_files",
    enabledSources: sourceMap.size,
    collectedItems,
    totalItems: collectedItems,
    eventItems: collectedItems,
    sources: Array.from(sourceMap.values())
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
