import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getDataDir } from "../lib/config.js";

const DEFAULT_DATA = {
  drafts: [],
  postedItemIds: []
};

export class PublishingStore {
  constructor(filePath = path.join(getDataDir(), "publishing.json")) {
    this.filePath = filePath;
  }

  async createDraft(item, text) {
    const data = await this.load();
    const draft = {
      id: crypto.randomBytes(6).toString("hex"),
      itemId: item.id,
      title: item.title,
      text,
      url: item.url,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    data.drafts.unshift(draft);
    await this.save(data);
    return draft;
  }

  async getDraft(draftId) {
    const data = await this.load();
    return data.drafts.find((draft) => draft.id === draftId);
  }

  async markDraft(draftId, status) {
    const data = await this.load();
    const draft = data.drafts.find((item) => item.id === draftId);

    if (!draft) return null;

    draft.status = status;
    draft.updatedAt = new Date().toISOString();

    if (status === "published" && draft.itemId && !data.postedItemIds.includes(draft.itemId)) {
      data.postedItemIds.push(draft.itemId);
    }

    await this.save(data);
    return draft;
  }

  async isItemPosted(itemId) {
    const data = await this.load();
    return data.postedItemIds.includes(itemId) || data.drafts.some((draft) => draft.itemId === itemId && draft.status === "pending");
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
