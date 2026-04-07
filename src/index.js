import "dotenv/config";
import { createBot, scheduleScans } from "./bot/telegram.js";
import { scheduleReminderDelivery } from "./reminders.js";
import { schedulePostApprovals } from "./publisher.js";
import { startServer } from "./server/app.js";

await startServer();
const bot = createBot();
scheduleScans(bot);
scheduleReminderDelivery(bot);
schedulePostApprovals(bot);

await bot.launch();
console.log("Kazan Event Radar bot is running.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
