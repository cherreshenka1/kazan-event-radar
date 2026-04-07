import cron from "node-cron";
import { UserStore } from "./storage/userStore.js";

export function scheduleReminderDelivery(bot) {
  const store = new UserStore();

  cron.schedule("* * * * *", async () => {
    const due = await store.listDueReminders();

    for (const { userId, reminder } of due) {
      try {
        await bot.telegram.sendMessage(userId, formatReminder(reminder), {
          disable_web_page_preview: false
        });
        await store.markReminderSent(userId, reminder.id);
      } catch (error) {
        console.warn(`Failed to deliver reminder ${reminder.id}: ${error.message}`);
      }
    }
  }, {
    timezone: "Europe/Moscow"
  });
}

function formatReminder(reminder) {
  const eventDate = new Date(reminder.eventDate);
  const dateText = eventDate.toLocaleString("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow"
  });

  return [
    `Напоминание ${reminder.offsetLabel}`,
    "",
    reminder.title,
    `Когда: ${dateText}`,
    reminder.url ? `Источник/билеты: ${reminder.url}` : null
  ].filter(Boolean).join("\n");
}
