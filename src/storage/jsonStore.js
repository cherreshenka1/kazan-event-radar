import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getDataDir } from "../lib/config.js";

export class JsonStore {
  constructor(filePath = path.join(getDataDir(), "items.json")) {
    this.filePath = filePath;
  }

  async loadItems() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async upsertItems(items) {
    const existingItems = await this.loadItems();
    const byId = new Map(existingItems.map((item) => [item.id, item]));

    for (const item of items) {
      const id = item.id || makeItemId(item);
      byId.set(id, {
        ...byId.get(id),
        ...item,
        id,
        seenAt: byId.get(id)?.seenAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    const nextItems = [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(nextItems, null, 2), "utf8");
    return nextItems;
  }
}

export function makeItemId(item) {
  const key = item.url || `${item.sourceId}:${item.title}:${item.publishedAt || item.eventDate || ""}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
}
