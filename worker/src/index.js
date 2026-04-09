import { CATALOG, MAIN_SECTIONS } from "../../src/data/catalog.js";

const TELEGRAM_SOURCES = [
  { id: "kuda-go-kazan", name: "KudaGo: Казань", channel: "kuda_go_kazan", categories: ["events", "places", "viewpoints", "hidden"] },
  { id: "kazan-kudago", name: "Куда пойти Казань", channel: "kazankudago", categories: ["events", "places", "restaurants", "bars"] },
  { id: "cool-kazan", name: "Интересная Казань", channel: "coolkazan", categories: ["events", "places", "viewpoints", "hidden"] },
  { id: "afisha-go-kazan", name: "Афиша GO Казань", channel: "afishagokazan", categories: ["events"] },
  { id: "kazan-mesta", name: "Казань места афиша", channel: "kazan_mesta", categories: ["events", "places", "restaurants", "bars", "hidden"] }
];

const TICKET_PLATFORMS = [
  { id: "yandex-afisha", name: "Яндекс Афиша", searchUrl: "https://afisha.yandex.ru/kazan?text={query}" },
  { id: "afisha-ru", name: "Афиша", searchUrl: "https://www.afisha.ru/kazan/?q={query}" },
  { id: "kassir-kzn", name: "Kassir.ru Казань", searchUrl: "https://kzn.kassir.ru/?search={query}" },
  { id: "mts-live", name: "МТС Live Казань", searchUrl: "https://live.mts.ru/kazan/search?query={query}" }
];

const CATEGORY_KEYWORDS = {
  events: ["афиша", "концерт", "выставка", "спектакль", "лекция", "маркет", "фестиваль", "вечеринка", "мастер-класс", "сегодня", "завтра", "выходные"],
  new_places: ["открыл", "открытие", "новое место", "новый ресторан", "новый бар", "запустил", "появил"],
  restaurants: ["ресторан", "завтрак", "ужин", "бранч", "кухня", "шеф", "меню", "кафе", "бистро"],
  bars: ["бар", "коктейль", "speakeasy", "секретный бар", "винная", "настойки"],
  viewpoints: ["панорама", "вид на", "смотровая", "крыша", "закат", "набережная", "колесо обозрения"],
  hidden: ["секрет", "неочевид", "скрыт", "двор", "тропа", "маршрут", "локальное место", "для своих"]
};

const MONTHS = {
  января: 0,
  феврал: 1,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11
};

export default {
  async fetch(request, env) {
    return handleRequest(request, env).catch((error) => {
      const status = error.status || 500;
      return json({ error: error.message }, status, env, error.headers);
    });
  },

  async scheduled(event, env) {
    if (event.cron === "0 6 * * *") {
      await prepareDraftBatch(env, Number(env.DRAFTS_PER_DAY || 10));
      return;
    }

    await deliverDueReminders(env);
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return corsResponse(null, 204, env);
  }

  if (url.pathname === "/health") {
    return json({ ok: true, service: "kazan-event-radar-worker" }, 200, env);
  }

  if (url.pathname === "/telegram/webhook" && request.method === "POST") {
    await handleTelegramUpdate(await request.json(), env);
    return json({ ok: true }, 200, env);
  }

  if (url.pathname === "/api/config") {
    return json({
      user: await optionalTelegramUser(request, env),
      miniAppUrl: env.MINI_APP_URL || null,
      channelUrl: env.TELEGRAM_CHANNEL_INVITE_URL || null
    }, 200, env);
  }

  if (url.pathname === "/api/catalog") {
    return json({ sections: MAIN_SECTIONS, catalog: CATALOG }, 200, env);
  }

  if (url.pathname === "/api/events") {
    const limit = Number(url.searchParams.get("limit") || 60);
    let items = await getJson(env, "events:items", []);

    if (items.length === 0) {
      items = await scanSources(env);
    }

    const filtered = items
      .filter((item) => item.categories?.includes("events") || item.eventDate)
      .filter((item) => isAllowedEventItem(item, env))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit)
      .map(attachTicketLinks);

    return json({
      period: "april",
      periodLabel: getAllowedEventWindowLabel(env),
      items: filtered
    }, 200, env);
  }

  if (url.pathname === "/api/favorites" && request.method === "GET") {
    const user = await requireTelegramUser(request, env);
    const profile = await getUser(env, user.id);
    return json({ favorites: profile.favorites || [] }, 200, env);
  }

  if (url.pathname === "/api/favorites/toggle" && request.method === "POST") {
    const user = await requireTelegramUser(request, env);
    const body = await request.json();
    const result = await toggleFavorite(env, user.id, body);
    await track(env, { type: "miniapp", action: "favorite_toggle", label: body.id, userId: user.id });
    return json(result, 200, env);
  }

  const reminderMatch = url.pathname.match(/^\/api\/reminders\/events\/([^/]+)$/);
  if (reminderMatch && request.method === "POST") {
    const user = await requireTelegramUser(request, env);
    const result = await createEventReminders(env, user.id, decodeURIComponent(reminderMatch[1]));
    await track(env, { type: "miniapp", action: "reminder_create", label: reminderMatch[1], userId: user.id });
    return json(result, 200, env);
  }

  if (url.pathname === "/api/reminders" && request.method === "GET") {
    const user = await requireTelegramUser(request, env);
    const profile = await getUser(env, user.id);
    return json({ reminders: profile.reminders || [] }, 200, env);
  }

  if (url.pathname === "/api/analytics/track" && request.method === "POST") {
    const user = await optionalTelegramUser(request, env);
    const body = await request.json();
    await track(env, {
      type: "miniapp",
      action: body.action || "unknown",
      label: body.label,
      userId: user?.id,
      metadata: body.metadata || {}
    });
    return json({ ok: true }, 200, env);
  }

  if (url.pathname === "/admin/analytics") {
    await requireAdmin(request, env);
    return html(renderAnalyticsPage(await analyticsSummary(env)), 200, env);
  }

  if (url.pathname === "/admin/analytics.json") {
    await requireAdmin(request, env);
    return json(await analyticsSummary(env), 200, env);
  }

  return json({ error: "Not found" }, 404, env);
}

async function handleTelegramUpdate(update, env) {
  if (update.message) await handleTelegramMessage(update.message, env);
  if (update.channel_post) await handleChannelPost(update.channel_post, env);
  if (update.callback_query) await handleCallback(update.callback_query, env);
}

async function handleTelegramMessage(message, env) {
  const text = message.text || "";
  const user = message.from;
  const chat = message.chat;

  await track(env, {
    type: text.startsWith("/") ? "bot_command" : "bot_message",
    action: text.startsWith("/") ? text.split(/\s+/)[0].slice(1) : "message",
    userId: user?.id,
    source: chat?.type
  });

  if (chat?.type === "private" && isManagerIdentity(user, env)) {
    const runtime = await getRuntime(env);
    runtime.managerChatId = String(chat.id);
    runtime.managerUsername = user.username || runtime.managerUsername || null;
    await putJson(env, "runtime", runtime);
  }

  if (text.startsWith("/start")) {
    await telegramApi(env, "sendMessage", {
      chat_id: chat.id,
      text: [
        "Я Kazan Event Radar: афиша, маршруты, места, избранное и напоминания по Казани.",
        "",
        "Откройте Mini App, чтобы собрать личный план."
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [[{ text: "Открыть афишу", web_app: { url: env.MINI_APP_URL } }]]
      }
    });
    return;
  }

  if (text.startsWith("/id")) {
    await telegramApi(env, "sendMessage", {
      chat_id: chat.id,
      text: `Chat ID: ${chat.id}`
    });
    return;
  }

  if (text.startsWith("/drafts") || text.startsWith("/draft")) {
    if (!isManagerIdentity(user, env)) {
      await telegramApi(env, "sendMessage", { chat_id: chat.id, text: "Эта команда доступна только менеджеру публикаций." });
      return;
    }

    const limit = text.startsWith("/drafts") ? Number(text.split(/\s+/)[1] || env.DRAFTS_PER_DAY || 10) : 1;
    const drafts = await prepareDraftBatch(env, limit);
    await telegramApi(env, "sendMessage", {
      chat_id: chat.id,
      text: drafts.length ? `Отправил черновики: ${drafts.length}.` : "Пока не нашел подходящие события для черновиков."
    });
  }
}

async function handleChannelPost(post, env) {
  const text = post.text || "";
  if (!text.startsWith("/channelid")) return;

  const runtime = await getRuntime(env);
  runtime.channelId = String(post.chat.id);
  runtime.channelTitle = post.chat.title || runtime.channelTitle || null;
  await putJson(env, "runtime", runtime);

  await telegramApi(env, "sendMessage", {
    chat_id: post.chat.id,
    text: `Channel ID saved: ${post.chat.id}`
  });
}

async function handleCallback(callback, env) {
  const user = callback.from;
  const data = callback.data || "";

  await track(env, { type: "bot_button", action: data.split(":")[0], label: data, userId: user?.id, source: "telegram" });
  await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id });

  if (!isManagerIdentity(user, env)) {
    await telegramApi(env, "sendMessage", { chat_id: user.id, text: "Согласовывать публикации может только менеджер." });
    return;
  }

  const [, action, draftId] = data.match(/^pub:(approve|reject):(.+)$/) || [];
  if (!draftId) return;

  if (action === "reject") {
    await markDraft(env, draftId, "rejected");
    await telegramApi(env, "sendMessage", { chat_id: user.id, text: "Черновик отклонен." });
    return;
  }

  const draft = await getDraft(env, draftId);
  if (!draft || draft.status !== "pending") {
    await telegramApi(env, "sendMessage", { chat_id: user.id, text: "Черновик уже обработан или не найден." });
    return;
  }

  const channelId = await resolveChannelId(env);
  if (!channelId) {
    await telegramApi(env, "sendMessage", { chat_id: user.id, text: "Не найден channel id. Добавьте бота админом и отправьте /channelid в канал." });
    return;
  }

  await telegramApi(env, "sendMessage", {
    chat_id: channelId,
    text: draft.text,
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [[{ text: "Открыть афишу", url: env.MINI_APP_URL }]]
    }
  });
  await markDraft(env, draftId, "published");
  await telegramApi(env, "sendMessage", { chat_id: user.id, text: "Пост опубликован в канал." });
}

async function prepareDraftBatch(env, limit) {
  const managerId = await resolveManagerChatId(env);
  if (!managerId) {
    console.log("Skipping drafts: manager chat id is not known yet.");
    return [];
  }

  await scanSources(env);
  const candidates = (await getJson(env, "events:items", []))
    .filter((item) => item.categories?.includes("events") || item.eventDate)
    .filter((item) => isAllowedEventItem(item, env))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const publishing = await getPublishing(env);
  const selected = [];

  for (const item of candidates) {
    const alreadyUsed = publishing.postedItemIds.includes(item.id) || publishing.drafts.some((draft) => draft.itemId === item.id && draft.status === "pending");
    if (!alreadyUsed) selected.push(item);
    if (selected.length >= limit) break;
  }

  if (selected.length === 0) {
    await telegramApi(env, "sendMessage", { chat_id: managerId, text: "Не нашел новых подходящих событий для черновиков." });
    return [];
  }

  await telegramApi(env, "sendMessage", {
    chat_id: managerId,
    text: `Подготовил черновики для канала: ${selected.length}. Период отбора: ${getAllowedEventWindowLabel(env)}.`
  });

  const drafts = [];
  for (const [index, item] of selected.entries()) {
    const draft = await createDraft(env, item);
    drafts.push(draft);
    await telegramApi(env, "sendMessage", {
      chat_id: managerId,
      text: [`Черновик ${index + 1}/${selected.length} для канала`, "", draft.text].join("\n"),
      reply_markup: {
        inline_keyboard: [
          [{ text: "Опубликовать", callback_data: `pub:approve:${draft.id}` }],
          [{ text: "Отклонить", callback_data: `pub:reject:${draft.id}` }]
        ]
      }
    });
  }

  return drafts;
}

async function scanSources(env) {
  const collected = [];

  for (const source of TELEGRAM_SOURCES) {
    try {
      collected.push(...await fetchTelegramSource(source));
    } catch (error) {
      console.warn(`Source ${source.id} failed: ${error.message}`);
    }
  }

  const existing = await getJson(env, "events:items", []);
  const byId = new Map(existing.map((item) => [item.id, item]));

  for (const item of collected) {
    byId.set(item.id, {
      ...byId.get(item.id),
      ...item,
      seenAt: byId.get(item.id)?.seenAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  const nextItems = [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  await putJson(env, "events:items", nextItems);
  return nextItems;
}

async function fetchTelegramSource(source) {
  const channel = source.channel.replace(/^@/, "");
  const html = await fetchText(`https://t.me/s/${channel}`);
  const chunks = html.split("tgme_widget_message").slice(1);
  const items = [];

  for (const chunk of chunks) {
    const dataPost = match(chunk, /data-post="([^"]+)"/);
    const textHtml = match(chunk, /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const publishedAt = match(chunk, /<time datetime="([^"]+)"/);
    const summary = normalizeText(stripHtml(textHtml || ""));

    if (!dataPost || !summary) continue;

    const item = classifyItem({
      sourceId: source.id,
      sourceName: source.name,
      type: "telegram_public_channel",
      title: firstLine(summary) || source.name,
      summary,
      url: `https://t.me/${dataPost}`,
      publishedAt,
      categories: source.categories || []
    });

    item.id = await itemId(item);
    items.push(item);
  }

  return items;
}

function classifyItem(item) {
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  const scores = {};

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[category] = keywords.reduce((score, keyword) => text.includes(keyword.toLowerCase()) ? score + 1 : score, 0);
  }

  const categories = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => category);

  return {
    ...item,
    categories: [...new Set([...(item.categories || []), ...categories])],
    eventDate: item.eventDate || extractEventDate(item),
    score: Object.values(scores).reduce((sum, score) => sum + score, item.score || 0)
  };
}

function extractEventDate(item, now = new Date()) {
  const text = `${item.title || ""}\n${item.summary || ""}`.toLowerCase();
  const time = extractTime(text);

  if (text.includes("сегодня")) {
    return toMoscowIso(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), time.hour, time.minute);
  }

  if (text.includes("завтра")) {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return toMoscowIso(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), time.hour, time.minute);
  }

  const found = text.match(/(?:^|\D)(\d{1,2})(?:\s*(?:-|–|—|и)\s*\d{1,2})?\s+(января|феврал[ья]|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/u);
  if (!found) return null;

  const day = Number(found[1]);
  const month = MONTHS[found[2]];
  const year = found[3] ? Number(found[3]) : inferYear(month, day, now);
  return toMoscowIso(year, month, day, time.hour, time.minute);
}

function extractTime(text) {
  const found = text.match(/(?:^|\D)([01]?\d|2[0-3])[:.](\d{2})(?:\D|$)/);
  return found ? { hour: Number(found[1]), minute: Number(found[2]) } : { hour: 12, minute: 0 };
}

function inferYear(month, day, now) {
  const year = now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, month, day));
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return candidate < monthAgo ? year + 1 : year;
}

function isAllowedEventItem(item, env) {
  const date = item.eventDate ? new Date(item.eventDate) : null;
  if (!date || Number.isNaN(date.getTime())) return false;
  const { from, to } = getAllowedEventWindow(env);
  return date >= from && date <= to;
}

function getAllowedEventWindow(env) {
  const [year, monthNumber] = (env.EVENT_TARGET_MONTH || "2026-04").split("-").map(Number);
  const monthIndex = monthNumber - 1;
  return {
    from: new Date(env.EVENTS_ALLOWED_FROM || Date.UTC(year, monthIndex, 1, -3, 0, 0)),
    to: new Date(env.EVENTS_ALLOWED_TO || (Date.UTC(year, monthIndex + 1, 1, -3, 0, 0) - 1))
  };
}

function getAllowedEventWindowLabel(env) {
  const { from, to } = getAllowedEventWindow(env);
  return `${formatMoscowDate(from)} - ${formatMoscowDate(to)}`;
}

function attachTicketLinks(item) {
  const query = encodeURIComponent(item.title || "Казань мероприятие");
  return {
    ...item,
    ticketLinks: TICKET_PLATFORMS.map((platform) => ({
      id: platform.id,
      name: platform.name,
      url: platform.searchUrl.replace("{query}", query)
    }))
  };
}

async function toggleFavorite(env, userId, favorite) {
  const profile = await getUser(env, userId);
  const favorites = profile.favorites || [];
  const index = favorites.findIndex((item) => item.id === favorite.id);

  if (index >= 0) favorites.splice(index, 1);
  else favorites.unshift({ ...favorite, addedAt: new Date().toISOString() });

  profile.favorites = favorites;
  profile.updatedAt = new Date().toISOString();
  await putJson(env, `user:${userId}`, profile);
  return { active: index < 0, favorites };
}

async function createEventReminders(env, userId, eventId) {
  const items = await getJson(env, "events:items", []);
  const event = items.find((item) => item.id === eventId);
  if (!event) return { reminders: [], created: [], skippedReason: "Событие не найдено." };

  const eventDate = event.eventDate ? new Date(event.eventDate) : null;
  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    return { reminders: [], created: [], skippedReason: "У события нет точной даты." };
  }

  const profile = await getUser(env, userId);
  const reminders = profile.reminders || [];
  const offsets = [
    { id: "24h", label: "за сутки", ms: 24 * 60 * 60 * 1000 },
    { id: "1h", label: "за час", ms: 60 * 60 * 1000 }
  ];
  const created = [];

  for (const offset of offsets) {
    const dueAt = new Date(eventDate.getTime() - offset.ms);
    if (dueAt <= new Date()) continue;
    if (reminders.some((reminder) => reminder.targetId === event.id && reminder.offset === offset.id && reminder.status === "pending")) continue;

    const reminder = {
      id: cryptoRandomId(),
      targetType: "event",
      targetId: event.id,
      title: event.title,
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

  profile.reminders = reminders;
  profile.updatedAt = new Date().toISOString();
  await putJson(env, `user:${userId}`, profile);
  return { reminders, created };
}

async function deliverDueReminders(env) {
  const list = await env.KAZAN_KV.list({ prefix: "user:" });
  const now = new Date();

  for (const key of list.keys) {
    const profile = await getJson(env, key.name, null);
    if (!profile?.reminders?.length) continue;

    let changed = false;
    for (const reminder of profile.reminders) {
      if (reminder.status !== "pending" || new Date(reminder.dueAt) > now) continue;

      await telegramApi(env, "sendMessage", {
        chat_id: profile.id,
        text: [
          `Напоминание ${reminder.offsetLabel}`,
          "",
          reminder.title,
          `Когда: ${formatMoscowDateTime(new Date(reminder.eventDate))}`,
          reminder.url ? `Источник/билеты: ${reminder.url}` : null
        ].filter(Boolean).join("\n")
      });
      reminder.status = "sent";
      reminder.sentAt = new Date().toISOString();
      changed = true;
    }

    if (changed) await putJson(env, key.name, profile);
  }
}

async function createDraft(env, item) {
  const publishing = await getPublishing(env);
  const draft = {
    id: cryptoRandomId(),
    itemId: item.id,
    title: item.title,
    text: formatChannelPost(item),
    url: item.url,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  publishing.drafts.unshift(draft);
  await putJson(env, "publishing", publishing);
  return draft;
}

async function getDraft(env, draftId) {
  const publishing = await getPublishing(env);
  return publishing.drafts.find((draft) => draft.id === draftId);
}

async function markDraft(env, draftId, status) {
  const publishing = await getPublishing(env);
  const draft = publishing.drafts.find((item) => item.id === draftId);
  if (!draft) return null;
  draft.status = status;
  draft.updatedAt = new Date().toISOString();
  if (status === "published" && draft.itemId && !publishing.postedItemIds.includes(draft.itemId)) {
    publishing.postedItemIds.push(draft.itemId);
  }
  await putJson(env, "publishing", publishing);
  return draft;
}

function formatChannelPost(item) {
  const eventDate = item.eventDate ? new Date(item.eventDate) : null;
  const when = eventDate && !Number.isNaN(eventDate.getTime()) ? formatMoscowDateTime(eventDate) : "дату уточняйте у организатора";
  return [
    `Казань: ${item.title || "интересное событие"}`,
    "",
    `Когда: ${when}`,
    item.sourceName ? `Источник: ${item.sourceName}` : null,
    "",
    trim(item.summary || item.title || "", 520),
    "",
    item.url ? `Билеты/подробнее: ${item.url}` : null,
    "",
    "#Казань #афиша #кудапойти"
  ].filter(Boolean).join("\n");
}

async function optionalTelegramUser(request, env) {
  const initData = readInitData(request);
  if (!initData) return env.ALLOW_DEV_AUTH === "true" ? { id: "dev-user" } : null;

  try {
    return await validateTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, Number(env.TELEGRAM_INIT_DATA_MAX_AGE || 24 * 60 * 60));
  } catch {
    return null;
  }
}

async function requireTelegramUser(request, env) {
  const user = await optionalTelegramUser(request, env);
  if (!user) throw new HttpError("Telegram initData is required.", 401);
  return user;
}

async function validateTelegramInitData(initData, botToken, maxAgeSeconds = 24 * 60 * 60) {
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required.");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("initData hash is missing.");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmac("WebAppData", botToken);
  const calculatedHash = bytesToHex(await hmac(secretKey, dataCheckString));
  if (hash !== calculatedHash) throw new Error("initData hash mismatch.");

  const authDate = Number(params.get("auth_date"));
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (!authDate || age > maxAgeSeconds) {
    throw new Error("initData is too old.");
  }

  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new Error("initData user is missing.");
  return { ...user, id: String(user.id) };
}

function readInitData(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("tma ") ? auth.slice(4) : request.headers.get("x-telegram-init-data") || "";
}

async function requireAdmin(request, env) {
  const expectedPassword = env.ANALYTICS_PASSWORD;
  const expectedUser = env.ANALYTICS_USERNAME || "admin";
  if (!expectedPassword) throw new HttpError("ANALYTICS_PASSWORD is not configured.", 503);
  const auth = request.headers.get("authorization") || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) throw new AuthError();
  const [user, password] = atob(encoded).split(":");
  if (user !== expectedUser || password !== expectedPassword) throw new AuthError();
}

async function track(env, event) {
  const events = await getJson(env, "analytics:events", []);
  events.push({
    ts: new Date().toISOString(),
    type: event.type,
    action: event.action,
    label: event.label || null,
    source: event.source || null,
    userHash: event.userId ? await hashUser(env, event.userId) : null,
    metadata: event.metadata || {}
  });
  await putJson(env, "analytics:events", events.slice(-5000));
}

async function analyticsSummary(env) {
  const events = await getJson(env, "analytics:events", []);
  const uniqueUsers = new Set(events.map((event) => event.userHash).filter(Boolean));
  return {
    totalEvents: events.length,
    uniqueUsers: uniqueUsers.size,
    byType: groupCount(events, "type"),
    byAction: groupCount(events, "action"),
    recentEvents: events.slice(-100).reverse()
  };
}

function renderAnalyticsPage(summary) {
  const rows = summary.recentEvents.map((event) => `<tr><td>${escapeHtml(event.ts)}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(event.action)}</td><td>${escapeHtml(event.label || "")}</td><td>${escapeHtml(event.userHash || "")}</td></tr>`).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kazan Analytics</title><style>body{font-family:Segoe UI,sans-serif;background:#07111f;color:#f8fafc;margin:0}main{max-width:1100px;margin:auto;padding:24px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card,table{background:#101f33;border:1px solid rgba(255,255,255,.12);border-radius:16px}.card{padding:16px}.metric{font-size:36px;color:#86efac;font-weight:800}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:10px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left}</style></head><body><main><h1>Kazan Event Radar Analytics</h1><div class="cards"><div class="card">Events<div class="metric">${summary.totalEvents}</div></div><div class="card">Users<div class="metric">${summary.uniqueUsers}</div></div><div class="card">Types<pre>${escapeHtml(JSON.stringify(summary.byType, null, 2))}</pre></div><div class="card">Actions<pre>${escapeHtml(JSON.stringify(summary.byAction, null, 2))}</pre></div></div><table><thead><tr><th>Time</th><th>Type</th><th>Action</th><th>Label</th><th>User hash</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
}

async function getUser(env, userId) {
  return await getJson(env, `user:${userId}`, {
    id: String(userId),
    favorites: [],
    reminders: [],
    createdAt: new Date().toISOString()
  });
}

async function getRuntime(env) {
  return await getJson(env, "runtime", { managerChatId: null, managerUsername: null, channelId: null, channelTitle: null });
}

async function getPublishing(env) {
  return await getJson(env, "publishing", { drafts: [], postedItemIds: [] });
}

async function resolveManagerChatId(env) {
  return env.TELEGRAM_MANAGER_CHAT_ID || (await getRuntime(env)).managerChatId;
}

async function resolveChannelId(env) {
  return env.TELEGRAM_CHANNEL_ID || (await getRuntime(env)).channelId;
}

function isManagerIdentity(user, env) {
  if (!user) return false;
  if (env.TELEGRAM_MANAGER_CHAT_ID && String(user.id) === String(env.TELEGRAM_MANAGER_CHAT_ID)) return true;
  return normalizeUsername(user.username) === normalizeUsername(env.TELEGRAM_MANAGER_USERNAME);
}

function normalizeUsername(username) {
  return String(username || "").replace(/^@/, "").trim().toLowerCase();
}

async function telegramApi(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "KazanEventRadarWorker/0.1" } });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

async function getJson(env, key, fallback) {
  const raw = await env.KAZAN_KV.get(key);
  return raw ? JSON.parse(raw) : fallback;
}

async function putJson(env, key, value) {
  await env.KAZAN_KV.put(key, JSON.stringify(value));
}

async function itemId(item) {
  return (await sha256(item.url || `${item.sourceId}:${item.title}:${item.publishedAt || item.eventDate || ""}`)).slice(0, 24);
}

async function hashUser(env, userId) {
  return (await sha256(`${env.ANALYTICS_SALT || env.TELEGRAM_BOT_TOKEN || "kazan-event-radar"}:${userId}`)).slice(0, 16);
}

async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#039;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function normalizeText(value) {
  return decodeHtml(value)
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function firstLine(value) {
  const lines = String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] || "";
}

function match(value, pattern) {
  return String(value || "").match(pattern)?.[1] || null;
}

function trim(value, maxLength) {
  const normalized = normalizeText(value);
  if (!maxLength || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function cryptoRandomId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function toMoscowIso(year, month, day, hour = 12, minute = 0) {
  return new Date(Date.UTC(year, month, day, hour - 3, minute, 0)).toISOString();
}

function formatMoscowDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(value);
}

function formatMoscowDateTime(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function groupCount(items, field) {
  return items.reduce((result, item) => {
    const key = item?.[field] || "unknown";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

function json(payload, status, env, extraHeaders = {}) {
  return corsResponse(JSON.stringify(payload), status, env, extraHeaders, "application/json; charset=utf-8");
}

function html(payload, status, env, extraHeaders = {}) {
  return corsResponse(payload, status, env, extraHeaders, "text/html; charset=utf-8");
}

function corsResponse(payload, status, env, extraHeaders = {}, contentType = "text/plain; charset=utf-8") {
  const miniAppOrigin = safeOrigin(env?.MINI_APP_URL);
  const headers = new Headers({
    "access-control-allow-origin": miniAppOrigin || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-telegram-init-data",
    "access-control-max-age": "86400",
    "content-type": contentType,
    ...extraHeaders
  });
  return new Response(payload, { status, headers });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

class HttpError extends Error {
  constructor(message, status = 400, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

class AuthError extends HttpError {
  constructor(message = "Authentication required.") {
    super(message, 401, { "www-authenticate": 'Basic realm="Kazan Event Radar Analytics"' });
  }
}
