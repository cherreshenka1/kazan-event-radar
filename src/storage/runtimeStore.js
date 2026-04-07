import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../lib/config.js";

const DEFAULT_DATA = {
  managerChatId: null,
  managerUsername: null,
  channelId: null,
  channelTitle: null,
  channelInviteUrl: null,
  updatedAt: null
};

export class RuntimeStore {
  constructor(filePath = path.join(getDataDir(), "runtime.json")) {
    this.filePath = filePath;
  }

  async get() {
    return this.load();
  }

  async setManagerChatId(chatId, username) {
    return this.update((data) => {
      data.managerChatId = String(chatId);
      data.managerUsername = username || data.managerUsername || null;
    });
  }

  async setChannelId(channelId, title) {
    return this.update((data) => {
      data.channelId = String(channelId);
      data.channelTitle = title || data.channelTitle || null;
      data.channelInviteUrl = process.env.TELEGRAM_CHANNEL_INVITE_URL || data.channelInviteUrl || null;
    });
  }

  async update(updater) {
    const data = await this.load();
    updater(data);
    data.updatedAt = new Date().toISOString();
    await this.save(data);
    return data;
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

export async function resolveManagerChatId() {
  if (process.env.TELEGRAM_MANAGER_CHAT_ID) {
    return process.env.TELEGRAM_MANAGER_CHAT_ID;
  }

  return (await new RuntimeStore().get()).managerChatId;
}

export async function resolveChannelId() {
  if (process.env.TELEGRAM_CHANNEL_ID) {
    return process.env.TELEGRAM_CHANNEL_ID;
  }

  return (await new RuntimeStore().get()).channelId;
}

export function normalizeTelegramUsername(username) {
  return String(username || "").trim().replace(/^@/, "").toLowerCase();
}

export function isManagerIdentity(user) {
  const managerId = process.env.TELEGRAM_MANAGER_CHAT_ID;
  const managerUsername = normalizeTelegramUsername(process.env.TELEGRAM_MANAGER_USERNAME);

  if (managerId && String(user?.id) === String(managerId)) {
    return true;
  }

  return Boolean(managerUsername && normalizeTelegramUsername(user?.username) === managerUsername);
}
