import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getDataDir } from "../lib/config.js";

const DEFAULT_DATA = {
  events: []
};

const MAX_EVENTS = 20000;

export class AnalyticsStore {
  constructor(filePath = path.join(getDataDir(), "analytics.json")) {
    this.filePath = filePath;
  }

  async track(event) {
    const data = await this.load();
    data.events.push({
      ts: new Date().toISOString(),
      type: event.type,
      action: event.action,
      label: event.label || null,
      source: event.source || null,
      userHash: event.userId ? hashUser(event.userId) : null,
      metadata: sanitizeMetadata(event.metadata || {})
    });

    if (data.events.length > MAX_EVENTS) {
      data.events = data.events.slice(-MAX_EVENTS);
    }

    await this.save(data);
  }

  async summary() {
    const data = await this.load();
    const events = data.events;
    const uniqueUsers = new Set(events.map((event) => event.userHash).filter(Boolean));

    return {
      totalEvents: events.length,
      uniqueUsers: uniqueUsers.size,
      byType: groupCount(events, "type"),
      byAction: groupCount(events, "action"),
      byDay: groupByDay(events),
      recentEvents: events.slice(-100).reverse()
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return { ...DEFAULT_DATA, ...JSON.parse(raw) };
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(DEFAULT_DATA);
      throw error;
    }
  }

  async save(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }
}

export const analyticsStore = new AnalyticsStore();

export function getUserIdFromContext(ctx) {
  return ctx.from?.id || ctx.chat?.id || null;
}

function hashUser(userId) {
  const salt = process.env.ANALYTICS_SALT || process.env.TELEGRAM_BOT_TOKEN || "kazan-event-radar";
  return crypto.createHash("sha256").update(`${salt}:${userId}`).digest("hex").slice(0, 16);
}

function sanitizeMetadata(metadata) {
  const result = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value).slice(0, 300);
    }
  }

  return result;
}

function groupCount(events, key) {
  return events.reduce((result, event) => {
    const value = event[key] || "unknown";
    result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
}

function groupByDay(events) {
  return events.reduce((result, event) => {
    const day = event.ts.slice(0, 10);
    result[day] = (result[day] || 0) + 1;
    return result;
  }, {});
}
