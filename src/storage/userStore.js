import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getDataDir } from "../lib/config.js";

const DEFAULT_DATA = {
  users: {}
};

export class UserStore {
  constructor(filePath = path.join(getDataDir(), "users.json")) {
    this.filePath = filePath;
  }

  async getUser(userId) {
    const data = await this.load();
    return data.users[userId] || createUser(userId);
  }

  async listFavorites(userId) {
    const user = await this.getUser(userId);
    return user.favorites || [];
  }

  async toggleFavorite(userId, favorite) {
    return this.updateUser(userId, (user) => {
      const favorites = user.favorites || [];
      const index = favorites.findIndex((item) => item.id === favorite.id);

      if (index >= 0) {
        favorites.splice(index, 1);
      } else {
        favorites.unshift({
          ...favorite,
          addedAt: new Date().toISOString()
        });
      }

      user.favorites = favorites;
      return {
        active: index < 0,
        favorites
      };
    });
  }

  async addEventReminders(userId, event, offsets = DEFAULT_OFFSETS) {
    return this.updateUser(userId, (user) => {
      const reminders = user.reminders || [];
      const eventDate = event.eventDate ? new Date(event.eventDate) : null;

      if (!eventDate || Number.isNaN(eventDate.getTime())) {
        return {
          reminders,
          created: [],
          skippedReason: "У события нет точной даты. Напоминание можно будет добавить после уточнения даты."
        };
      }

      const created = [];

      for (const offset of offsets) {
        const dueAt = new Date(eventDate.getTime() - offset.ms);

        if (dueAt <= new Date()) {
          continue;
        }

        const existing = reminders.find((reminder) => (
          reminder.targetType === "event" &&
          reminder.targetId === event.id &&
          reminder.offset === offset.id &&
          reminder.status === "pending"
        ));

        if (existing) {
          continue;
        }

        const reminder = {
          id: crypto.randomBytes(8).toString("hex"),
          targetType: "event",
          targetId: event.id,
          title: event.title || "Событие",
          url: event.url,
          eventDate: eventDate.toISOString(),
          dueAt: dueAt.toISOString(),
          offset: offset.id,
          offsetLabel: offset.label,
          status: "pending",
          createdAt: new Date().toISOString()
        };

        reminders.push(reminder);
        created.push(reminder);
      }

      user.reminders = reminders;
      return { reminders, created };
    });
  }

  async listDueReminders(now = new Date()) {
    const data = await this.load();
    const due = [];

    for (const [userId, user] of Object.entries(data.users)) {
      for (const reminder of user.reminders || []) {
        if (reminder.status === "pending" && new Date(reminder.dueAt) <= now) {
          due.push({ userId, reminder });
        }
      }
    }

    return due;
  }

  async markReminderSent(userId, reminderId) {
    return this.updateUser(userId, (user) => {
      const reminder = (user.reminders || []).find((item) => item.id === reminderId);

      if (reminder) {
        reminder.status = "sent";
        reminder.sentAt = new Date().toISOString();
      }

      return reminder;
    });
  }

  async updateUser(userId, updater) {
    const data = await this.load();
    const user = data.users[userId] || createUser(userId);
    const result = updater(user);
    user.updatedAt = new Date().toISOString();
    data.users[userId] = user;
    await this.save(data);
    return result;
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

const DEFAULT_OFFSETS = [
  { id: "24h", label: "за сутки", ms: 24 * 60 * 60 * 1000 },
  { id: "1h", label: "за час", ms: 60 * 60 * 1000 }
];

function createUser(userId) {
  return {
    id: String(userId),
    favorites: [],
    reminders: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
