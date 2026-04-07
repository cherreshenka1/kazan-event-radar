import cron from "node-cron";
import { Markup } from "telegraf";
import { loadItems, scanSources } from "./aggregator.js";
import { PublishingStore } from "./storage/publishingStore.js";
import { isManagerIdentity, resolveChannelId, resolveManagerChatId } from "./storage/runtimeStore.js";
import { getAllowedEventWindowLabel, isAllowedEventItem } from "./lib/eventFilter.js";

const DEFAULT_APPROVAL_CRON = "0 9 * * *";
const DEFAULT_DRAFTS_PER_DAY = 10;

export function registerPublisher(bot) {
  bot.command("draft", async (ctx) => {
    if (!isManagerIdentity(ctx.from)) {
      await ctx.reply("Эта команда доступна только менеджеру публикаций.");
      return;
    }

    const drafts = await prepareDraftBatchForApproval(bot, 1);
    await ctx.reply(drafts.length ? "Черновик отправлен на согласование." : "Пока не нашел подходящее событие для черновика.");
  });

  bot.command("drafts", async (ctx) => {
    if (!isManagerIdentity(ctx.from)) {
      await ctx.reply("Эта команда доступна только менеджеру публикаций.");
      return;
    }

    const limit = Number(ctx.message?.text?.split(/\s+/)[1] || process.env.DRAFTS_PER_DAY || DEFAULT_DRAFTS_PER_DAY);
    const drafts = await prepareDraftBatchForApproval(bot, limit);
    await ctx.reply(drafts.length ? `Отправил черновики на согласование: ${drafts.length}.` : "Пока не нашел подходящие события для черновиков.");
  });

  bot.action(/^pub:approve:([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    if (!isManagerIdentity(ctx.from)) {
      await ctx.reply("Согласовывать публикации может только менеджер.");
      return;
    }

    const store = new PublishingStore();
    const draft = await store.getDraft(ctx.match[1]);

    if (!draft || draft.status !== "pending") {
      await ctx.reply("Черновик уже обработан или не найден.");
      return;
    }

    const channelId = await resolveChannelId();

    if (!channelId) {
      await ctx.reply("Не нашел channel id. Добавьте бота админом в канал и отправьте в канал /channelid.");
      return;
    }

    const publishOptions = {
      disable_web_page_preview: false
    };

    const keyboard = channelKeyboard();
    if (keyboard) {
      publishOptions.reply_markup = keyboard.reply_markup;
    }

    await bot.telegram.sendMessage(channelId, draft.text, publishOptions);
    await store.markDraft(draft.id, "published");
    await ctx.reply("Пост опубликован в канал.");
  });

  bot.action(/^pub:reject:([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    if (!isManagerIdentity(ctx.from)) {
      await ctx.reply("Отклонять публикации может только менеджер.");
      return;
    }

    const store = new PublishingStore();
    const draft = await store.markDraft(ctx.match[1], "rejected");

    await ctx.reply(draft ? "Черновик отклонен." : "Черновик не найден.");
  });
}

export function schedulePostApprovals(bot) {
  cron.schedule(process.env.POST_APPROVAL_CRON || DEFAULT_APPROVAL_CRON, async () => {
    await prepareDraftBatchForApproval(bot, Number(process.env.DRAFTS_PER_DAY || DEFAULT_DRAFTS_PER_DAY));
  }, {
    timezone: "Europe/Moscow"
  });
}

export async function prepareDraftForApproval(bot) {
  const drafts = await prepareDraftBatchForApproval(bot, 1);
  return drafts[0] || null;
}

export async function prepareDraftBatchForApproval(bot, limit = DEFAULT_DRAFTS_PER_DAY) {
  const managerId = await resolveManagerChatId();

  if (!managerId) {
    console.warn("Post approval skipped: manager chat id is not known yet. Ask the manager to send /start or /id to the bot.");
    return [];
  }

  await scanSources();
  const items = await pickNextPublishableItems(limit);

  if (items.length === 0) {
    await bot.telegram.sendMessage(managerId, "Не нашел новых подходящих событий для черновиков.");
    return [];
  }

  const store = new PublishingStore();
  const drafts = [];

  await bot.telegram.sendMessage(managerId, `Подготовил черновики для канала: ${items.length}. Период отбора: ${getAllowedEventWindowLabel()}. Проверьте каждый и публикуйте в удобное время.`);

  for (const [index, item] of items.entries()) {
    const draft = await store.createDraft(item, formatChannelPost(item));
    drafts.push(draft);

    await bot.telegram.sendMessage(managerId, [
      `Черновик ${index + 1}/${items.length} для канала`,
      "",
      draft.text
    ].join("\n"), approvalKeyboard(draft.id));
  }

  return drafts;
}

async function pickNextPublishableItems(limit) {
  const store = new PublishingStore();
  const items = await loadItems();
  const selected = [];

  const candidates = items
    .filter((item) => item.categories?.includes("events") || item.eventDate)
    .filter((item) => isAllowedEventItem(item))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const item of candidates) {
    if (!(await store.isItemPosted(item.id))) {
      selected.push(item);
    }

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

function formatChannelPost(item) {
  const eventDate = item.eventDate ? new Date(item.eventDate) : null;
  const when = eventDate && !Number.isNaN(eventDate.getTime())
    ? eventDate.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" })
    : "дату уточняйте у организатора";

  const summary = trim(item.summary || item.title || "", 520);

  return [
    `Казань: ${item.title || "интересное событие"}`,
    "",
    `Когда: ${when}`,
    item.sourceName ? `Источник: ${item.sourceName}` : null,
    "",
    summary,
    "",
    item.url ? `Билеты/подробнее: ${item.url}` : null,
    "",
    "#Казань #афиша #кудапойти"
  ].filter(Boolean).join("\n");
}

function approvalKeyboard(draftId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Опубликовать", `pub:approve:${draftId}`)],
    [Markup.button.callback("Отклонить", `pub:reject:${draftId}`)]
  ]);
}

function channelKeyboard() {
  const url = process.env.MINI_APP_URL;

  if (!url) {
    return null;
  }

  return Markup.inlineKeyboard([[Markup.button.webApp("Открыть афишу", url)]]);
}

function trim(text, maxLength) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
