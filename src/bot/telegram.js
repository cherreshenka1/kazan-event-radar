import { Markup, Telegraf } from "telegraf";
import cron from "node-cron";
import { loadItems, scanSources } from "../aggregator.js";
import { formatDigest } from "../lib/format.js";
import { isWithinDays } from "../lib/dates.js";
import { registerMenu, showMainMenu } from "./menu.js";
import { registerPublisher } from "../publisher.js";
import { isManagerIdentity, RuntimeStore } from "../storage/runtimeStore.js";
import { registerBotAnalytics } from "./analytics.js";

export function createBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and add a BotFather token.");
  }

  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  const runtimeStore = new RuntimeStore();

  registerBotAnalytics(bot);

  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat?.type === "private" && isManagerIdentity(ctx.from)) {
      await runtimeStore.setManagerChatId(ctx.chat.id, ctx.from.username);
    }

    return next();
  });

  bot.on("channel_post", async (ctx) => {
    const text = ctx.channelPost?.text || "";

    if (text.trim().startsWith("/channelid")) {
      await runtimeStore.setChannelId(ctx.chat.id, ctx.chat.title);
      await ctx.telegram.sendMessage(ctx.chat.id, `Channel ID saved: ${ctx.chat.id}`);
    }
  });

  registerMenu(bot);
  registerPublisher(bot);

  bot.start(async (ctx) => {
    await ctx.reply([
      "Я Kazan Event Radar: афиша, маршруты, места, избранное и напоминания по Казани.",
      "",
      "Лучший интерфейс будет в Mini App, а здесь можно быстро открыть меню или запросить афишу командами.",
      "Команды: /menu, /today, /week, /places, /secrets, /scan."
    ].join("\n"), startKeyboard());
  });

  bot.help(showMainMenu);

  bot.command("id", async (ctx) => {
    if (ctx.chat?.type === "private" && isManagerIdentity(ctx.from)) {
      await runtimeStore.setManagerChatId(ctx.chat.id, ctx.from.username);
    }

    await ctx.reply(`Chat ID: ${ctx.chat.id}`);
  });

  bot.command("channelid", async (ctx) => {
    if (ctx.chat?.type !== "channel") {
      await ctx.reply("Send /channelid inside the Telegram channel after adding this bot as an admin.");
      return;
    }

    await runtimeStore.setChannelId(ctx.chat.id, ctx.chat.title);
    await ctx.reply(`Channel ID saved: ${ctx.chat.id}`);
  });

  bot.command("scan", async (ctx) => {
    await ctx.reply("Сканирую источники. Это может занять несколько секунд.");
    const items = await scanSources();
    await ctx.reply(`Готово. В базе сейчас ${items.length} материалов.`);
  });

  bot.command("today", async (ctx) => {
    const items = (await loadItems()).filter((item) => isWithinDays(item, 1));
    await ctx.reply(formatDigest(items, "Казань: ближайшее на сегодня"));
  });

  bot.command("week", async (ctx) => {
    const items = (await loadItems()).filter((item) => isWithinDays(item, 7));
    await ctx.reply(formatDigest(items, "Казань: интересное на ближайшую неделю"));
  });

  bot.command("places", async (ctx) => {
    const items = (await loadItems()).filter((item) => intersects(item.categories, ["new_places", "restaurants", "bars", "viewpoints"]));
    await ctx.reply(formatDigest(items, "Казань: места, рестораны, бары и виды"));
  });

  bot.command("secrets", async (ctx) => {
    const items = (await loadItems()).filter((item) => intersects(item.categories, ["hidden", "bars", "viewpoints"]));
    await ctx.reply(formatDigest(items, "Казань: секретные места и маршруты"));
  });

  return bot;
}

export function scheduleScans(bot) {
  const expression = process.env.SCAN_CRON || "*/30 * * * *";

  cron.schedule(expression, async () => {
    const items = await scanSources();
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

    if (chatId) {
      await bot.telegram.sendMessage(chatId, formatDigest(items, "Казань: свежий радар"));
    }
  }, {
    timezone: "Europe/Moscow"
  });
}

function startKeyboard() {
  const rows = [];

  if (process.env.MINI_APP_URL) {
    rows.push([Markup.button.webApp("Открыть Mini App", process.env.MINI_APP_URL)]);
  }

  rows.push([Markup.button.callback("Меню в чате", "menu:main")]);

  return Markup.inlineKeyboard(rows);
}

function intersects(values = [], expected = []) {
  return expected.some((value) => values.includes(value));
}
