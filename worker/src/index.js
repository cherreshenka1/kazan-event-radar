import sourceConfig from "../../config/sources.json" with { type: "json" };
import ticketPlatformsConfig from "../../config/ticket-platforms.json" with { type: "json" };
import { CATALOG, MAIN_SECTIONS } from "../../src/data/catalog.js";
import { renderAdminDashboard } from "../../src/lib/adminDashboard.js";

const DAILY_DRAFTS_CRON = "0 6 * * *";
const HOURLY_SCAN_CRON = "15 * * * *";
const DEFAULT_EVENTS_API_LIMIT = 600;
const WORKER_SCAN_EXCLUDED_SOURCE_IDS = new Set([
  "yandex-festival",
  "yandex-musical",
  "mts-popular",
  "mts-festivals",
  "sport-rubin-official",
  "sport-unics-official"
]);

const EVENT_SOURCES = (sourceConfig.sources || [])
  .filter((source) => source.enabled)
  .filter((source) => !WORKER_SCAN_EXCLUDED_SOURCE_IDS.has(source.id))
  .filter((source) => ["yandex_afisha_listing", "mts_live_collection"].includes(source.type))
  .map((source) => ({
    id: source.id,
    name: source.name,
    type: source.type,
    url: source.url,
    section: source.section || "events",
    limit: Number(source.limit || 20),
    pages: Number(source.pages || 1),
    parser: String(source.parser || ""),
    homeVenue: String(source.homeVenue || "")
  }));

const PERSISTED_EVENT_TYPES = new Set([
  "yandex_afisha_listing",
  "mts_live_collection",
  "official_sport_schedule",
  "mts_live_browser",
  "yandex_afisha_browser",
  "kassir_browser",
  "browser_import"
]);

const TICKET_PLATFORMS = (ticketPlatformsConfig.platforms || [])
  .filter((platform) => platform.enabled && platform.searchUrl)
  .map((platform) => ({
    id: platform.id,
    name: platform.name,
    searchUrl: platform.searchUrl
  }));

const EXCLUDED_EVENT_KEYWORDS = [
  "розыгрыш",
  "авиабилет",
  "авиабилеты",
  "самолет",
  "самолёт"
];

const EVENT_FINGERPRINT_STOP_WORDS = new Set([
  "казань",
  "казани",
  "город",
  "сегодня",
  "завтра",
  "апрель",
  "апреля",
  "афиша",
  "мероприятие",
  "событие",
  "концерт",
  "выставка",
  "лекция",
  "фестиваль",
  "спектакль",
  "билеты",
  "билет",
  "начало",
  "клуб",
  "центр",
  "пространство",
  "вечер",
  "день"
]);

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

const SAFE_EXCLUDED_EVENT_KEYWORDS = [
  "розыгрыш",
  "авиабилет",
  "авиабилеты",
  "самолет",
  "самолёт"
];

const SAFE_EVENT_FINGERPRINT_STOP_WORDS = new Set([
  "казань",
  "казани",
  "город",
  "сегодня",
  "завтра",
  "апрель",
  "апреля",
  "афиша",
  "мероприятие",
  "событие",
  "концерт",
  "выставка",
  "лекция",
  "фестиваль",
  "спектакль",
  "билеты",
  "билет",
  "начало",
  "клуб",
  "центр",
  "пространство",
  "вечер",
  "день"
]);

const SAFE_MONTHS = {
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

const TATAR_SPECIFIC_LETTERS = /[ӘәӨөҮүҢңҖҗҺһ]/u;

export default {
  async fetch(request, env) {
    return handleRequest(request, env).catch((error) => {
      const status = error.status || 500;
      return json({ error: error.message }, status, env, error.headers);
    });
  },

  async scheduled(event, env) {
    if (event.cron === DAILY_DRAFTS_CRON) {
      try {
        await ensureDailyDraftBatch(env, Number(env.DRAFTS_PER_DAY || 10), {
          refresh: false,
          reason: "daily_drafts"
        });
      } catch (error) {
        console.warn(`Daily drafts job failed: ${error.message}`);
      }
      return;
    }

    if (event.cron === HOURLY_SCAN_CRON) {
      try {
        await scanSources(env, { reason: "scheduled_refresh" });
      } catch (error) {
        console.warn(`Scheduled refresh failed: ${error.message}`);
      }
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
    const [meta, eventsRefresh, catalogRefresh] = await Promise.all([
      getEventMeta(env),
      getJson(env, "system:eventsRefreshReport", null),
      getJson(env, "system:catalogRefreshReport", null)
    ]);
    return json({
      ok: true,
      service: "kazan-event-radar-worker",
      enabledSources: EVENT_SOURCES.length,
      lastScanAt: meta?.lastScanAt || null,
      eventItems: meta?.eventItems || meta?.totalItems || 0,
      eventsRefreshAt: eventsRefresh?.finishedAt || null,
      catalogRefreshAt: catalogRefresh?.finishedAt || null,
      catalogSections: Array.isArray(catalogRefresh?.sections) ? catalogRefresh.sections.length : 0
    }, 200, env);
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

  if (url.pathname === "/api/image") {
    return proxyExternalImage(url.searchParams.get("url"), env);
  }

  if (url.pathname === "/api/events") {
    const limit = Number(url.searchParams.get("limit") || DEFAULT_EVENTS_API_LIMIT);
    const filters = buildEventFilters(url.searchParams, env);
    let items = await getJson(env, "events:items", []);
    let meta = await getEventMeta(env, items);

    if (items.length === 0) {
      const scanResult = await scanSources(env, { reason: "api_cache_miss" });
      items = scanResult.items;
      meta = scanResult.meta;
    }

    const filteredAll = items
      .filter((item) => item.categories?.includes("events") || item.eventDate)
      .filter((item) => isAllowedEventItem(item, env, filters))
      .filter((item) => matchesEventCategory(item, filters.category))
      .sort(compareEventPriority)
      .map(attachTicketLinksSafe);

    const filtered = filteredAll.slice(0, limit);

    const syncedAt = meta?.lastScanAt || items.find((item) => item.updatedAt)?.updatedAt || null;

    return json({
      period: "rolling",
      periodLabel: formatEventFilterLabel(filters),
      allowedPeriodLabel: getAllowedEventWindowLabel(env),
      syncedAt,
      totalItems: meta?.totalItems || items.length,
      matchingItems: filteredAll.length,
      filters: {
        allowedFrom: formatDateInput(filters.allowedFrom),
        allowedTo: formatDateInput(filters.allowedTo),
        defaultFrom: formatDateInput(filters.defaultFrom),
        defaultTo: formatDateInput(filters.defaultTo),
        appliedFrom: formatDateInput(filters.from),
        appliedTo: formatDateInput(filters.to)
      },
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

  if (url.pathname === "/admin/reindex-events" && request.method === "POST") {
    await requireAdmin(request, env);
    const result = await scanSources(env, { reason: "admin_reindex" });
    return json({ ok: true, meta: result.meta }, 200, env);
  }

  if (url.pathname === "/internal/run-drafts" && request.method === "POST") {
    await requireAutomationToken(request, env);
    const body = request.headers.get("content-type")?.includes("application/json")
      ? await request.json().catch(() => ({}))
      : {};
    const limit = Number(url.searchParams.get("limit") || body.limit || env.DRAFTS_PER_DAY || 10);
    const refresh = parseBooleanFlag(url.searchParams.get("refresh"), body.refresh, false);
    const force = parseBooleanFlag(url.searchParams.get("force"), body.force, false);
    const result = await ensureDailyDraftBatch(env, limit, {
      refresh,
      force,
      reason: force ? "internal_drafts_force" : "internal_drafts"
    });
    return json({ ok: true, ...result }, 200, env);
  }

  if (url.pathname === "/admin/import-events" && request.method === "POST") {
    await requireAdmin(request, env);
    const payload = await request.json();
    const result = await importExternalEvents(env, payload);
    return json(result, 200, env);
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
  const command = text.split(/\s+/)[0].toLowerCase();
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

  if (command === "/start" || command === "/app" || command === "/menu") {
    await sendMiniAppEntry(chat.id, env, [
      "Я Kazan Event Radar: афиша, маршруты, места, избранное и напоминания по Казани.",
      "",
      "Откройте Mini App, чтобы собрать личный план по апрелю 2026."
    ].join("\n"));
    return;
  }

  if (command === "/status") {
    const meta = await getEventMeta(env);
    await telegramApi(env, "sendMessage", {
      chat_id: chat.id,
      text: formatScanSummary(meta, env)
    });
    return;
  }

  if (command === "/scan") {
    if (!isManagerIdentity(user, env)) {
      await telegramApi(env, "sendMessage", { chat_id: chat.id, text: "Эта команда доступна только менеджеру публикаций." });
      return;
    }

    const result = await scanSources(env, { reason: "manager_command" });
    await telegramApi(env, "sendMessage", {
      chat_id: chat.id,
      text: [
        "Сканирование завершено.",
        "",
        formatScanSummary(result.meta, env)
      ].join("\n")
    });
    return;
  }

  if (command === "/id") {
    await telegramApi(env, "sendMessage", {
      chat_id: chat.id,
      text: `Chat ID: ${chat.id}`
    });
    return;
  }

  if (command === "/drafts" || command === "/draft") {
    if (!isManagerIdentity(user, env)) {
      await telegramApi(env, "sendMessage", { chat_id: chat.id, text: "Эта команда доступна только менеджеру публикаций." });
      return;
    }

    const limit = command === "/drafts" ? Number(text.split(/\s+/)[1] || env.DRAFTS_PER_DAY || 10) : 1;
    const drafts = await prepareDraftBatch(env, limit, {
      refresh: false,
      reason: "manager_drafts"
    });
    await telegramApi(env, "sendMessage", {
      chat_id: chat.id,
      text: drafts.length ? `Отправил черновики: ${drafts.length}.` : "Пока не нашел подходящие события для черновиков."
    });
    return;
  }

  if (chat?.type === "private") {
    await sendMiniAppEntry(chat.id, env, "Откройте Mini App, чтобы посмотреть афишу, маршруты, места и избранное.");
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
    text: `ID канала сохранен: ${post.chat.id}`
  });
}

async function handleCallback(callback, env) {
  const user = callback.from;
  const data = callback.data || "";

  await track(env, { type: "bot_button", action: data.split(":")[0], label: data, userId: user?.id, source: "telegram" });
  await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id });

  if (!isManagerIdentity(user, env)) {
    await telegramApi(env, "sendMessage", { chat_id: user.id, text: "Публикациями управляет только менеджер канала." });
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

  await sendDraftPost(env, channelId, draft, {
    inline_keyboard: [[
      ...(draft.url ? [{ text: "Источник", url: draft.url }] : []),
      ...(env.MINI_APP_URL ? [{ text: "Mini App", url: env.MINI_APP_URL }] : [])
    ]]
  });
  await markDraft(env, draftId, "published");
  await telegramApi(env, "sendMessage", { chat_id: user.id, text: "Пост опубликован в канал." });
}

async function prepareDraftBatch(env, limit, options = {}) {
  const managerId = await resolveManagerChatId(env);
  if (!managerId) {
    console.log("Skipping drafts: manager chat id is not known yet.");
    return [];
  }

  if (options.refresh !== false) {
    await scanSources(env, { reason: options.reason || "draft_batch" });
  }
  const candidates = (await getJson(env, "events:items", []))
    .filter((item) => item.categories?.includes("events") || item.eventDate)
    .filter((item) => isAllowedEventItem(item, env))
    .sort(compareEventPriority);

  const publishing = await getPublishing(env);
  const selected = selectDraftCandidates(candidates, publishing, limit, env);

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
    try {
      await sendDraftPost(env, managerId, {
        ...draft,
        text: [`Черновик ${index + 1}/${selected.length} для канала`, "", draft.text].join("\n")
      }, {
        inline_keyboard: [
          [{ text: "Опубликовать", callback_data: `pub:approve:${draft.id}` }],
          [{ text: "Отклонить", callback_data: `pub:reject:${draft.id}` }]
        ]
      });
      drafts.push(draft);
    } catch (error) {
      console.warn(`Failed to deliver draft ${draft.id}: ${error.message}`);
      await markDraft(env, draft.id, "failed");
    }
  }

  if (selected.length > 0 && drafts.length === 0) {
    await telegramApi(env, "sendMessage", {
      chat_id: managerId,
      text: "Не удалось доставить черновики менеджеру. Проверьте связь бота с Telegram и повторите запуск."
    });
  }

  return drafts;
}

async function ensureDailyDraftBatch(env, limit, options = {}) {
  const target = Math.max(1, Number(limit || env.DRAFTS_PER_DAY || 10) || 10);
  const now = options.now ? new Date(options.now) : new Date();
  const force = options.force === true;
  const publishing = await getPublishing(env);
  const preparedToday = force ? 0 : getPreparedDraftCountForDate(publishing, now);

  if (!force && preparedToday >= target) {
    return {
      drafts: [],
      count: 0,
      preparedToday,
      target,
      skippedReason: "already_prepared_today"
    };
  }

  const remaining = force ? target : Math.max(0, target - preparedToday);
  if (remaining <= 0) {
    return {
      drafts: [],
      count: 0,
      preparedToday,
      target,
      skippedReason: "nothing_remaining"
    };
  }

  const drafts = await prepareDraftBatch(env, remaining, options);
  if (!drafts.length) {
    return {
      drafts,
      count: 0,
      preparedToday,
      target,
      skippedReason: "no_candidates"
    };
  }

  const refreshedPublishing = await getPublishing(env);
  const currentToday = force ? 0 : getPreparedDraftCountForDate(refreshedPublishing, now);
  refreshedPublishing.lastDraftBatchAt = now.toISOString();
  refreshedPublishing.lastDraftBatchCount = currentToday + drafts.length;
  await putJson(env, "publishing", {
    drafts: refreshedPublishing.drafts,
    postedItemIds: refreshedPublishing.postedItemIds,
    postedItems: refreshedPublishing.postedItems,
    lastDraftBatchAt: refreshedPublishing.lastDraftBatchAt,
    lastDraftBatchCount: refreshedPublishing.lastDraftBatchCount
  });

  return {
    drafts,
    count: drafts.length,
    preparedToday: refreshedPublishing.lastDraftBatchCount,
    target
  };
}

async function scanSources(env, options = {}) {
  const collected = [];
  const sourceStats = [];
  let yandexBlockedForRun = false;

  for (const source of EVENT_SOURCES) {
    if (yandexBlockedForRun && source.type === "yandex_afisha_listing") {
      sourceStats.push({
        id: source.id,
        name: source.name,
        status: "skipped",
        count: 0,
        error: "Skipped after Yandex anti-bot response in this scan."
      });
      continue;
    }

    try {
      const items = await fetchEventSource(source);
      collected.push(...items);
      sourceStats.push({ id: source.id, name: source.name, status: "ok", count: items.length });
    } catch (error) {
      if (source.type === "yandex_afisha_listing" && /anti-bot/i.test(String(error.message || ""))) {
        yandexBlockedForRun = true;
      }
      sourceStats.push({ id: source.id, name: source.name, status: "error", count: 0, error: error.message });
      console.warn(`Source ${source.id} failed: ${error.message}`);
    }
  }

  const existing = (await getJson(env, "events:items", []))
    .filter((item) => PERSISTED_EVENT_TYPES.has(item.type));
  const nextItems = pruneExpiredEventItems(await collapseDuplicateItems([
    ...existing.map((item) => ({ ...item, _fromExisting: true })),
    ...collected.map((item) => ({ ...item, _seenThisScan: true }))
  ]));
  const meta = {
    lastScanAt: new Date().toISOString(),
    reason: options.reason || "manual",
    enabledSources: EVENT_SOURCES.length,
    collectedItems: collected.length,
    totalItems: nextItems.length,
    eventItems: nextItems.filter((item) => (item.categories?.includes("events") || item.eventDate) && isAllowedEventItem(item, env)).length,
    sources: sourceStats
  };

  await putJson(env, "events:items", nextItems);
  await putJson(env, "events:meta", meta);
  return { items: nextItems, meta };
}

async function importExternalEvents(env, payload = {}) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const sourceKey = String(payload.source || "browser_import");
  const sourceType = mapImportedSourceType(sourceKey);
  const sourceName = mapImportedSourceName(sourceKey);
  const importMode = normalizeExternalImportMode(payload.mode);
  const reportedImportedCount = Math.max(0, Number(payload.reportedImportedCount || 0)) || items.length;

  if (!items.length) {
    return {
      ok: true,
      mode: importMode,
      imported: 0,
      totalItems: (await getJson(env, "events:items", [])).length
    };
  }

  const prepared = [];

  for (const raw of items) {
    const item = prepareImportedEventItem(raw, sourceKey, sourceType, sourceName);
    if (!item || shouldRejectEventItem(item)) continue;
    item.id = await itemId(item);
    prepared.push(item);
  }

  const existing = (await getJson(env, "events:items", []))
    .filter((item) => PERSISTED_EVENT_TYPES.has(item.type))
    .filter((item) => importMode === "replace_source" ? item.type !== sourceType : true);
  const mergedItems = await mergeImportedEventItems(existing, prepared);
  const nextItems = pruneImportedItemsToAllowedWindow(mergedItems, env);
  const previousMeta = await getJson(env, "events:meta", null);
  const incomingMetaSources = normalizeImportedMetaSources(payload.sourceStats, sourceKey, sourceName, importMode, reportedImportedCount);
  const derivedMetaSources = inferImportedMetaSourcesFromItems(nextItems);
  const metaSources = mergeImportedMetaSources(derivedMetaSources, previousMeta?.sources, incomingMetaSources);

  const meta = {
    lastScanAt: payload.syncedAt || new Date().toISOString(),
    reason: `import:${sourceKey}:${importMode}`,
    enabledSources: EVENT_SOURCES.length,
    collectedItems: reportedImportedCount,
    totalItems: nextItems.length,
    eventItems: nextItems.filter((item) => (item.categories?.includes("events") || item.eventDate) && isAllowedEventItem(item, env)).length,
    sources: metaSources
  };

  await putJson(env, "events:items", nextItems);
  await putJson(env, "events:meta", meta);

  return {
    ok: true,
    source: sourceKey,
    mode: importMode,
    imported: prepared.length,
    totalItems: nextItems.length,
    meta
  };
}

function normalizeImportedMetaSources(sourceStats, sourceKey, sourceName, importMode, fallbackCount) {
  if (Array.isArray(sourceStats) && sourceStats.length) {
    const normalized = sourceStats
      .map((source) => ({
        id: source?.id || sourceKey,
        name: source?.name || source?.sourceName || sourceName,
        status: source?.status || "ok",
        mode: source?.mode || importMode,
        count: Math.max(0, Number(source?.count ?? source?.importedItems ?? 0)),
        collectedLinks: Math.max(0, Number(source?.collectedLinks ?? 0)),
        queuedLinks: Math.max(0, Number(source?.queuedLinks ?? 0)),
        skippedKnownLinks: Math.max(0, Number(source?.skippedKnownLinks ?? 0))
      }))
      .filter((source) => source.id || source.name);

    if (normalized.length) {
      return normalized;
    }
  }

  return [{
    id: sourceKey,
    name: sourceName,
    status: "ok",
    mode: importMode,
    count: fallbackCount
  }];
}

function mergeImportedMetaSources(...sourceGroups) {
  const merged = new Map();

  for (const group of sourceGroups) {
    for (const source of group || []) {
      const normalized = normalizeImportedMetaSourceEntry(source);
      if (!normalized) continue;
      const key = normalized.id || normalized.name;
      const current = merged.get(key) || {};
      merged.set(key, {
        ...current,
        ...normalized
      });
    }
  }

  return [...merged.values()].sort((left, right) => {
    const countDiff = Number(right?.count || 0) - Number(left?.count || 0);
    if (countDiff) return countDiff;
    return String(left?.name || left?.id || "").localeCompare(String(right?.name || right?.id || ""), "ru");
  });
}

function normalizeImportedMetaSourceEntry(source) {
  if (!source || typeof source !== "object") return null;

  const id = source.id || source.sourceId || "";
  const name = source.name || source.sourceName || resolveConfiguredSourceName(id) || id || "";
  if (!id && !name) return null;

  return {
    id,
    name,
    status: source.status || "ok",
    mode: source.mode || "merge",
    count: Math.max(0, Number(source.count ?? source.importedItems ?? 0)),
    collectedLinks: Math.max(0, Number(source.collectedLinks ?? 0)),
    queuedLinks: Math.max(0, Number(source.queuedLinks ?? 0)),
    skippedKnownLinks: Math.max(0, Number(source.skippedKnownLinks ?? 0))
  };
}

function pruneImportedItemsToAllowedWindow(items, env) {
  return (items || [])
    .map((item) => normalizePersistedImportedEventItem(item))
    .filter((item) => isAllowedEventItem(item, env));
}

function normalizePersistedImportedEventItem(item) {
  if (!item || typeof item !== "object") return item;

  const primarySourceId = normalizeText(item?.sourceId || item?.sourceIds?.[0] || "");
  const section = resolveImportedEventSection(item, primarySourceId);
  const kind = normalizeEventKind(section || item?.kind || "events");

  return {
    ...item,
    sourceId: primarySourceId || item?.sourceId || "",
    sourceName: normalizeText(item?.sourceName || item?.sourceNames?.[0] || resolveConfiguredSourceName(primarySourceId) || ""),
    section,
    kind,
    categories: [...new Set(
      ["events", ...(Array.isArray(item?.categories) ? item.categories : []), kind]
        .map((value) => normalizeText(value))
        .filter(Boolean)
    )],
    subtitle: normalizeText(item?.subtitle || ""),
    summary: normalizeText(item?.summary || item?.rawSummary || item?.shortSummary || ""),
    shortSummary: normalizeText(item?.shortSummary || item?.summary || item?.rawSummary || ""),
    venueTitle: normalizeText(item?.venueTitle || ""),
    venueUrl: item?.venueUrl ? normalizeAbsoluteUrl(item.venueUrl, true) : "",
    imageUrl: item?.imageUrl ? normalizeAbsoluteUrl(item.imageUrl, true) : null,
    url: canonicalEventUrl(item?.url),
    dateText: normalizeText(item?.dateText || ""),
    sourceLabel: normalizeText(item?.sourceLabel || "")
  };
}

function resolveImportedEventSection(item, primarySourceId = "") {
  const explicitSection = normalizeText(item?.section || "");
  if (explicitSection) return explicitSection;

  const categorySection = (Array.isArray(item?.categories) ? item.categories : [])
    .map((value) => normalizeText(value))
    .find((value) => value && value !== "events");
  if (categorySection) return categorySection;

  const sourceIds = [primarySourceId, ...(Array.isArray(item?.sourceIds) ? item.sourceIds : [])]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  for (const sourceId of sourceIds) {
    const configuredSection = resolveConfiguredSourceSection(sourceId);
    if (configuredSection) return configuredSection;
  }

  const yandexSection = resolveYandexSection(item?.url, "");
  if (yandexSection) return yandexSection;

  return normalizeEventKind(item?.kind || "");
}

function inferImportedMetaSourcesFromItems(items) {
  const counts = new Map();

  for (const item of items || []) {
    if (!PERSISTED_EVENT_TYPES.has(item?.type)) continue;
    const sourceIds = Array.isArray(item?.sourceIds) && item.sourceIds.length
      ? item.sourceIds
      : [item?.sourceId].filter(Boolean);
    const sourceNames = Array.isArray(item?.sourceNames) ? item.sourceNames : [];

    sourceIds.forEach((sourceId, index) => {
      const id = normalizeText(sourceId);
      if (!id) return;
      const name = normalizeText(sourceNames[index] || item?.sourceName || resolveConfiguredSourceName(id) || id);
      const current = counts.get(id) || {
        id,
        name,
        status: "ok",
        mode: "merge",
        count: 0
      };
      current.count += 1;
      if (!current.name && name) current.name = name;
      counts.set(id, current);
    });
  }

  return [...counts.values()].sort((left, right) => {
    const countDiff = Number(right?.count || 0) - Number(left?.count || 0);
    if (countDiff) return countDiff;
    return String(left?.name || left?.id || "").localeCompare(String(right?.name || right?.id || ""), "ru");
  });
}

async function mergeImportedEventItems(existingItems, preparedItems) {
  const nowIso = new Date().toISOString();
  const nextItems = existingItems.map((item) => ({ ...item, _fromExisting: true }));
  const indexById = new Map(nextItems.map((item, index) => [item.id, index]));
  const bucketMap = new Map();

  for (const item of nextItems) {
    const bucketKey = importedEventBucketKey(item);
    if (!bucketMap.has(bucketKey)) bucketMap.set(bucketKey, []);
    bucketMap.get(bucketKey).push(item);
  }

  for (const rawItem of preparedItems) {
    const candidate = ensureEventAggregate({ ...rawItem, _seenThisScan: true });
    const bucketKey = importedEventBucketKey(candidate);
    const bucket = bucketMap.get(bucketKey) || [];
    const current = bucket.find((item) => areLikelySameEvent(item, candidate)) || null;

    if (current) {
      const merged = finalizeMergedItem(mergeDuplicateItems(current, candidate, nowIso));
      merged.id = current.id || merged.id || await fingerprintId(merged.fingerprint);

      const index = indexById.get(current.id);
      if (typeof index === "number") {
        nextItems[index] = merged;
      }

      const bucketIndex = bucket.indexOf(current);
      if (bucketIndex >= 0) {
        bucket[bucketIndex] = merged;
      }

      indexById.delete(current.id);
      indexById.set(merged.id, typeof index === "number" ? index : nextItems.length);
      continue;
    }

    const finalized = finalizeMergedItem(candidate);
    finalized.id = finalized.id || await fingerprintId(finalized.fingerprint);

    nextItems.push(finalized);
    bucket.push(finalized);
    bucketMap.set(bucketKey, bucket);
    indexById.set(finalized.id, nextItems.length - 1);
  }

  const collapsedItems = await collapseDuplicateItems(pruneExpiredEventItems(nextItems));

  return collapsedItems.sort((a, b) => {
    const updatedDiff = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    if (updatedDiff) return updatedDiff;
    return compareEventPriority(a, b);
  });
}

function importedEventBucketKey(item) {
  return formatDateInput(item?.eventDate) || "undated";
}

function prepareImportedEventItem(raw, sourceKey, sourceType, sourceName) {
  const title = buildShortEventTitleSafe(raw?.title || "");
  const url = canonicalEventUrl(raw?.url);
  if (!title || !url) return null;

  const section = raw?.section || resolveYandexSection(url, "events");
  const kind = normalizeEventKind(section);
  const rawSummary = cleanEventSummary(raw?.summary || raw?.description || raw?.subtitle || title);
  const timing = resolveImportedEventTiming(raw);

  return applySafeEventCopySafe(classifyItem({
    sourceId: raw?.sourceId || sourceKey,
    sourceName: raw?.sourceName || sourceName,
    type: sourceType,
    section,
    kind,
    title,
    subtitle: normalizeText(raw?.subtitle || ""),
    rawSummary,
    summary: rawSummary,
    shortSummary: rawSummary,
    url,
    imageUrl: raw?.imageUrl ? normalizeAbsoluteUrl(raw.imageUrl, true) : null,
    eventDate: timing.eventDate,
    eventHasExplicitTime: timing.eventHasExplicitTime,
    dateText: normalizeText(raw?.dateText || ""),
    venueTitle: normalizeText(raw?.venueTitle || ""),
    venueUrl: raw?.venueUrl ? normalizeAbsoluteUrl(raw.venueUrl, true) : "",
    sourceLabel: normalizeText(raw?.sourceLabel || ""),
    publishedAt: null,
    categories: ["events", kind],
    baseScore: Number(raw?.baseScore || 56),
    score: Number(raw?.score || raw?.baseScore || 56)
  }));
}

function mapImportedSourceType(sourceKey) {
  return {
    mts_browser: "mts_live_browser",
    yandex_browser: "yandex_afisha_browser",
    kassir_browser: "kassir_browser"
  }[sourceKey] || "browser_import";
}

function mapImportedSourceName(sourceKey) {
  return {
    mts_browser: "MTS Live Browser",
    yandex_browser: "Yandex Afisha Browser",
    kassir_browser: "Kassir Browser"
  }[sourceKey] || "Browser Import";
}

function resolveConfiguredSourceName(sourceId) {
  const normalizedId = normalizeText(sourceId);
  if (!normalizedId) return "";
  const configuredSource = (sourceConfig.sources || []).find((source) => normalizeText(source?.id) === normalizedId);
  return normalizeText(configuredSource?.name || "");
}

function resolveConfiguredSourceSection(sourceId) {
  const normalizedId = normalizeText(sourceId);
  if (!normalizedId) return "";
  const configuredSource = (sourceConfig.sources || []).find((source) => normalizeText(source?.id) === normalizedId);
  return normalizeText(configuredSource?.section || "");
}

function normalizeImportedEventDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return toMoscowIsoFromLocalString(value);
  return date.toISOString();
}

function resolveImportedEventTiming(raw) {
  const directDate = normalizeImportedEventDate(raw?.eventDate);
  const textForDate = [
    raw?.dateText,
    raw?.subtitle,
    raw?.summary,
    raw?.shortSummary,
    raw?.description,
    raw?.title
  ].filter(Boolean).join("\n");
  const fallbackDate = directDate || extractImportedEventDateFromText(textForDate);
  const eventHasExplicitTime = Boolean(
    raw?.eventHasExplicitTime
    || /(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/.test(String(textForDate || ""))
  );

  return {
    eventDate: fallbackDate,
    eventHasExplicitTime: Boolean(fallbackDate && eventHasExplicitTime)
  };
}

function extractImportedEventDateFromText(value, now = new Date()) {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  const isoMatch = normalized.match(/(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:\D+(\d{1,2}):(\d{2}))?/u);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]) - 1;
    const day = Number(isoMatch[3]);
    const hour = isoMatch[4] ? Number(isoMatch[4]) : 12;
    const minute = isoMatch[5] ? Number(isoMatch[5]) : 0;
    return toMoscowIso(year, month, day, hour, minute);
  }

  const numericMatch = normalized.match(/(?:^|\D)(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/u);
  if (numericMatch) {
    const day = Number(numericMatch[1]);
    const month = Number(numericMatch[2]) - 1;
    const year = Number(numericMatch[3]);
    const hour = numericMatch[4] ? Number(numericMatch[4]) : 12;
    const minute = numericMatch[5] ? Number(numericMatch[5]) : 0;
    return toMoscowIso(year, month, day, hour, minute);
  }

  const text = normalized.toLowerCase();
  const time = extractTime(text);
  const found = text.match(/(?:^|\D)(\d{1,2})(?:\s*(?:-|–|—|и)\s*\d{1,2}|\s+по\s+\d{1,2})?\s+(января|феврал[ья]|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?(?:,\s*[а-яё]+)?/u);
  if (!found) return null;

  const day = Number(found[1]);
  const month = MONTHS[found[2]];
  const year = found[3] ? Number(found[3]) : inferYear(month, day, now);
  return toMoscowIso(year, month, day, time.hour, time.minute);
}

function canonicalEventUrl(value) {
  return normalizeAbsoluteUrl(value, false);
}

function normalizeAbsoluteUrl(value, preserveQuery = false) {
  const url = toAbsoluteUrl("https://afisha.yandex.ru", String(value || "").trim());
  if (!url) return "";

  try {
    const parsed = new URL(url);
    if (!preserveQuery) {
      parsed.search = "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

async function fetchEventSource(source) {
  if (source.type === "mts_live_collection") {
    return fetchMtsLiveSource(source);
  }

  if (source.type === "yandex_afisha_listing") {
    return fetchYandexAfishaSource(source);
  }

  if (source.type === "official_sport_schedule") {
    return fetchOfficialSportSource(source);
  }

  throw new Error(`Unsupported source type: ${source.type}`);
}

async function fetchMtsLiveSource(source) {
  const links = [];

  for (let page = 1; page <= Math.max(1, source.pages || 1); page += 1) {
    const pageUrl = page === 1 ? source.url : `${source.url}?page=${page}`;
    const html = await fetchText(pageUrl, { referer: "https://live.mts.ru/kazan" });
    links.push(...extractMtsAnnouncementLinks(html));
  }

  const uniqueLinks = uniqueStrings(links).slice(0, source.limit || 20);
  const items = [];

  for (const link of uniqueLinks) {
    const html = await fetchText(link, { referer: source.url });
    const item = parseMtsAnnouncementPage(html, link, source);
    if (!item || shouldRejectEventItem(item)) continue;
    item.id = await itemId(item);
    items.push(item);
  }

  return items;
}

async function fetchYandexAfishaSource(source) {
  const html = await fetchText(source.url, { referer: "https://afisha.yandex.ru/kazan" });
  if (isCaptchaPage(html)) {
    throw new Error("Yandex Afisha returned an anti-bot page.");
  }

  const uniqueLinks = uniqueStrings(extractYandexAnnouncementLinks(html)).slice(0, source.limit || 20);
  const items = [];

  for (const link of uniqueLinks) {
    const detailsHtml = await fetchText(link, { referer: source.url });
    if (isCaptchaPage(detailsHtml)) continue;
    const item = parseYandexAnnouncementPage(detailsHtml, link, source);
    if (!item || shouldRejectEventItem(item)) continue;
    item.id = await itemId(item);
    items.push(item);
  }

  return items;
}

async function fetchOfficialSportSource(source) {
  const html = await fetchText(source.url, { referer: source.url });
  let parsedItems = [];

  if (source.parser === "rubin") {
    parsedItems = parseRubinOfficialMatches(html, source);
  } else if (source.parser === "unics") {
    parsedItems = parseUnicsOfficialMatches(html, source);
  } else {
    throw new Error(`Unsupported official sport parser: ${source.parser || "unknown"}`);
  }

  const uniqueItems = [];
  for (const item of parsedItems.slice(0, source.limit || parsedItems.length || 20)) {
    if (!item || shouldRejectEventItem(item)) continue;
    item.id = await itemId(item);
    uniqueItems.push(item);
  }

  return uniqueItems;
}

function parseRubinOfficialMatches(html, source) {
  return [...String(html || "").matchAll(/<tr\b[\s\S]*?<\/tr>/gi)]
    .map((entry) => parseRubinOfficialMatchRow(entry[0], source))
    .filter(Boolean);
}

function parseRubinOfficialMatchRow(rowHtml, source) {
  const arenaChunk = match(rowHtml, /<div class="arena">([\s\S]*?)<\/div>/i) || "";
  const title = normalizeText(match(arenaChunk, /<span>([^<]+)<\/span>/i));
  if (!title) return null;

  const rawDateText = normalizeText(stripHtml(match(rowHtml, /<div class="date[^"]*">([\s\S]*?)<\/div>/i) || ""));
  const dateText = normalizeText(rawDateText.replace(/Добавить[\s\S]*/iu, ""));
  const eventDate = extractImportedEventDateFromText(dateText);
  if (!eventDate) return null;

  const venueTitle = normalizeText(stripHtml(arenaChunk).replace(title, "")) || source.homeVenue || "";
  const eventHref = match(rowHtml, /<div class="date[^"]*">[\s\S]*?<a[^>]+href="([^"]+)"/i)
    || match(arenaChunk, /<a[^>]+href="([^"]+)"/i)
    || source.url;
  const imageCandidates = [...String(rowHtml || "").matchAll(/<img[^>]+src="([^"]+)"/gi)]
    .map((entry) => toAbsoluteUrl(source.url, decodeHtml(entry[1])))
    .filter(Boolean);
  const isHomeMatch = normalizeText(title).toLowerCase().startsWith("рубин");
  const summary = [
    `Официальный матч ФК «Рубин»: ${title}.`,
    isHomeMatch
      ? `Домашняя игра пройдет${venueTitle ? ` на площадке ${venueTitle}` : " в Казани"}.`
      : venueTitle
        ? `Выездная игра пройдет на площадке ${venueTitle}.`
        : "Выездная игра включена в официальный календарь клуба.",
    dateText ? `Время в календаре клуба: ${dateText}.` : ""
  ].filter(Boolean).join(" ");

  return buildOfficialSportItem({
    source,
    title,
    summary,
    venueTitle,
    url: toAbsoluteUrl(source.url, eventHref),
    imageUrl: imageCandidates[1] || imageCandidates[0] || "",
    eventDate,
    eventHasExplicitTime: /(?:^|\D)([01]?\d|2[0-3]):(\d{2})(?:\D|$)/.test(dateText),
    baseScore: isHomeMatch ? 70 : 66
  });
}

function parseUnicsOfficialMatches(html, source) {
  return [...String(html || "").matchAll(/<tr\b[^>]*data-id="[^"]+"[^>]*>[\s\S]*?<\/tr>/gi)]
    .map((entry) => parseUnicsOfficialMatchRow(entry[0], source))
    .filter(Boolean);
}

function parseUnicsOfficialMatchRow(rowHtml, source) {
  const cells = [...String(rowHtml || "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((entry) => entry[1]);
  if (cells.length < 6) return null;

  const tournament = normalizeText(match(cells[0], /<img[^>]+title="([^"]+)"/i) || "");
  const stage = normalizeText(stripHtml(cells[1]));
  const dateRaw = normalizeText(stripHtml(cells[2]));
  const timeRaw = normalizeText(stripHtml(cells[3]));
  const eventDate = normalizeImportedEventDate(dateRaw);
  if (!eventDate) return null;

  const home = /fa-home/i.test(cells[4]);
  const opponent = normalizeText(match(cells[5], /<b[^>]*>([\s\S]*?)<\/b>/i) ? stripHtml(match(cells[5], /<b[^>]*>([\s\S]*?)<\/b>/i)) : "");
  if (!opponent) return null;

  const locationText = normalizeText(stripHtml(cells[5]).replace(opponent, ""));
  const venueTitle = home ? (source.homeVenue || "Баскет-холл") : locationText;
  const title = `УНИКС - ${opponent}`;
  const imageUrl = toAbsoluteUrl(source.url, decodeHtml(match(cells[0], /<img[^>]+src="([^"]+)"/i) || ""));
  const summary = [
    `Официальный матч БК «УНИКС»: ${title}.`,
    tournament ? `Турнир: ${tournament}.` : "",
    stage ? `Стадия: ${stage}.` : "",
    home
      ? `Домашняя встреча пройдет${venueTitle ? ` в ${venueTitle}` : " в Казани"}.`
      : venueTitle
        ? `Выездная встреча пройдет в ${venueTitle}.`
        : "Выездная встреча указана в официальном календаре клуба."
  ].filter(Boolean).join(" ");

  return buildOfficialSportItem({
    source,
    title,
    summary,
    venueTitle,
    url: buildOfficialSportEventUrl(source.url, {
      event: title,
      at: dateRaw
    }),
    imageUrl,
    eventDate,
    eventHasExplicitTime: Boolean(timeRaw || /(?:^|\D)([01]?\d|2[0-3]):(\d{2})(?:\D|$)/.test(dateRaw)),
    baseScore: home ? 68 : 64
  });
}

function buildOfficialSportItem({
  source,
  title,
  summary,
  venueTitle,
  url,
  imageUrl,
  eventDate,
  eventHasExplicitTime = false,
  baseScore = 64
}) {
  if (!title || !url || !eventDate) return null;
  const rawSummary = cleanEventSummary(summary || title);

  return applySafeEventCopySafe(classifyItem({
    sourceId: source.id,
    sourceName: source.name,
    type: source.type,
    kind: "sport",
    title: buildShortEventTitle(title),
    rawSummary,
    summary: rawSummary,
    shortSummary: rawSummary,
    url: normalizeAbsoluteUrl(url, true),
    imageUrl: imageUrl ? toAbsoluteUrl(url, imageUrl) : null,
    eventDate,
    eventHasExplicitTime: Boolean(eventHasExplicitTime),
    venueTitle: normalizeText(venueTitle || ""),
    publishedAt: null,
    categories: ["events", "sport"],
    baseScore,
    score: baseScore
  }));
}

function buildOfficialSportEventUrl(baseUrl, params = {}) {
  try {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (!value) continue;
      url.searchParams.set(key, String(value));
    }
    url.hash = "";
    return url.toString();
  } catch {
    return String(baseUrl || "");
  }
}

function extractMtsAnnouncementLinks(html) {
  return [...new Set(
    [...String(html || "").matchAll(/href=["']((?:https?:\/\/live\.mts\.ru)?\/kazan\/announcements\/[^"'#\s]+(?:\?[^"'#\s]*)?)["']/gi)]
      .map((match) => decodeHtml(match[1]))
      .map((link) => link.replace(/#.*$/i, ""))
      .map((link) => toAbsoluteUrl("https://live.mts.ru", link))
  )];
}

function extractYandexAnnouncementLinks(html) {
  const links = [...String(html || "").matchAll(/href=["'](\/kazan\/[^"'#\s]+\/[^"'#\s]+(?:\?[^"'#\s]*)?)["']/gi)]
    .map((match) => decodeHtml(match[1]))
    .filter((link) => !/[?&]source=menu/i.test(link))
    .filter((link) => !/^\/kazan\/(?:artist|events|certificates|my|ticket|venue|venues)(?:\/|$)/i.test(link))
    .filter((link) => !/\/places\//i.test(link))
    .filter((link) => !/\/selections\//i.test(link))
    .map((link) => link.replace(/#schedule.*$/i, ""))
    .map((link) => toAbsoluteUrl("https://afisha.yandex.ru", link));

  return [...new Set(links)];
}

function parseMtsAnnouncementPage(html, url, source) {
  const data = extractNextDataJson(html);
  const details = data?.props?.pageProps?.initialState?.Announcements?.announcementDetails;
  if (!details?.title) return null;
  const resolvedSection = resolveMtsSection(details, source.section);
  const resolvedEventDate = pickFirstValidEventDate(details.eventClosestDateTime, details.lastEventDateTime);
  const rawSummary = cleanEventSummary(stripHtml(details.description || details.shortDescription || details.title || ""));
  const imageUrl = resolveMtsImageUrl(details, html);

  return applySafeEventCopySafe(classifyItem({
    sourceId: source.id,
    sourceName: source.name,
    type: source.type,
    kind: normalizeEventKind(resolvedSection),
    title: buildShortEventTitle(details.title),
    rawSummary,
    summary: rawSummary,
    shortSummary: rawSummary,
    url,
    imageUrl: imageUrl ? toAbsoluteUrl(url, imageUrl) : null,
    eventDate: toMoscowIsoFromLocalString(resolvedEventDate),
    eventHasExplicitTime: Boolean(resolvedEventDate),
    venueTitle: normalizeText(details.venue?.title || ""),
    publishedAt: null,
    categories: ["events", normalizeEventKind(resolvedSection)],
    baseScore: 50,
    score: 50
  }));
}

function resolveMtsImageUrl(details, html = "") {
  const mediaItems = Array.isArray(details?.media) ? details.media : [];
  const mediaPoster = mediaItems.find((item) => /poster/i.test(String(item?.type || "")))?.url || "";
  const mediaGallery = mediaItems.find((item) => /gallery/i.test(String(item?.type || "")))?.url || "";
  const candidates = [
    details?.poster?.url,
    details?.posterUrl,
    details?.banner?.url,
    details?.banner?.src,
    mediaPoster,
    mediaGallery,
    extractMetaContent(html, "og:image"),
    extractMetaContent(html, "twitter:image")
  ];

  return candidates.find((value) => normalizeText(value)) || "";
}

function parseYandexAnnouncementPage(html, url, source) {
  const titleTag = normalizeText(match(html, /<title[^>]*>([^<]+)<\/title>/i));
  const description = cleanEventSummary(extractMetaContent(html, "description"));
  const parsed = parseYandexTitle(titleTag, description, source.section);
  const imageUrl = extractMetaContent(html, "og:image");

  if (!parsed.title) return null;

  return applySafeEventCopySafe(classifyItem({
    sourceId: source.id,
    sourceName: source.name,
    type: source.type,
    kind: normalizeEventKind(resolveYandexSection(url, source.section)),
    title: buildShortEventTitle(parsed.title),
    rawSummary: description || parsed.summary || parsed.title,
    summary: description || parsed.summary || parsed.title,
    shortSummary: description || parsed.summary || parsed.title,
    url,
    imageUrl: imageUrl ? toAbsoluteUrl(url, imageUrl) : null,
    eventDate: parsed.eventDate,
    eventHasExplicitTime: parsed.eventHasExplicitTime,
    venueTitle: parsed.venueTitle,
    publishedAt: null,
    categories: ["events", normalizeEventKind(resolveYandexSection(url, source.section))],
    baseScore: 48,
    score: 48
  }));
}

function parseYandexTitle(titleTag, description, section) {
  const cleaned = normalizeText(
    String(titleTag || "")
      .replace(/\s+—\s+Яндекс.*$/iu, "")
      .replace(/^Билеты на\s+/iu, "")
      .trim()
  );

  const dateText = match(cleaned, /(\d{2}\.\d{2}\.\d{4})/);
  const timeText = match(description || "", /(?:^|\D)((?:[01]?\d|2[0-3]):[0-5]\d)(?:\D|$)/);
  const summaryVenue = match(description || "", /в Казани,\s*([^.,]+)(?:[.,]|$)/iu);
  let rawTitle = cleaned;

  if (dateText) {
    rawTitle = cleaned.split(dateText)[0] || cleaned;
  }

  rawTitle = normalizeText(rawTitle.replace(/\b(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер-класс)\b/giu, "").trim());

  const venueTitle = normalizeText(
    match(cleaned, /\d{2}\.\d{2}\.\d{4}\s+(.+?)\s+(?:концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер-класс)\b/iu)
      || summaryVenue
      || ""
  );

  return {
    title: rawTitle || cleaned,
    summary: description,
    venueTitle,
    eventHasExplicitTime: Boolean(timeText),
    eventDate: dateText ? toMoscowIsoFromDateText(dateText, timeText) : null
  };
}

function extractNextDataJson(html) {
  const raw = match(html, /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractMetaContent(html, name) {
  return normalizeText(
    decodeHtml(
      match(html, new RegExp(`<meta[^>]+property=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"))
      || match(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegExp(name)}["']`, "i"))
      || match(html, new RegExp(`<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"))
      || match(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRegExp(name)}["']`, "i"))
      || ""
    )
  );
}

function shouldRejectEventItem(item) {
  const title = String(item.title || "");
  const summary = String(item.summary || item.rawSummary || "");
  const rawSummary = String(item.rawSummary || "");
  const haystack = normalizeFingerprintTextSafe(`${title} ${summary}`);

  if (TATAR_SPECIFIC_LETTERS.test(`${title} ${summary} ${rawSummary}`)) {
    return true;
  }

  return SAFE_EXCLUDED_EVENT_KEYWORDS.some((keyword) => haystack.includes(normalizeFingerprintTextSafe(keyword)));
}

function cleanEventSummary(value) {
  return trim(
    normalizeText(String(value || ""))
      .replace(/Описание, даты проведения и фотографии[^.]*\./giu, "")
      .replace(/Купить билеты[^.]*\./giu, "")
      .replace(/на Яндекс Афише\.*$/giu, "")
      .replace(/на МТС Live\.*$/giu, ""),
    320
  );
}

function normalizeEventKind(section) {
  return {
    concert: "concert",
    concerts: "concert",
    concert_popular: "concert",
    theatre: "theatre",
    theater: "theatre",
    theatre_show: "theatre",
    spectacle: "theatre",
    spectacle_popular: "theatre",
    monoperformance: "theatre",
    show: "show",
    festival: "festival",
    circus_show: "show",
    show_and_musicals: "show",
    standup: "standup",
    exhibition: "exhibition",
    exhibitions: "exhibition",
    art: "exhibition",
    excursion: "excursion",
    excursions: "excursion",
    musical: "musical",
    musicals: "musical",
    sport: "sport",
    sports: "sport",
    kids: "kids",
    children: "kids"
  }[section] || "events";
}

function toAbsoluteUrl(origin, value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return new URL(value, origin).toString();
}

function toMoscowIsoFromLocalString(value) {
  if (!value) return null;
  if (!isValidEventDateValue(value)) return null;
  if (/Z$/i.test(value) || /[+-]\d{2}:\d{2}$/i.test(value)) return new Date(value).toISOString();
  return new Date(`${value}+03:00`).toISOString();
}

function pickFirstValidEventDate(...values) {
  return values.find((value) => isValidEventDateValue(value)) || null;
}

function isValidEventDateValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  if (/^0001-01-01T00:00:00(?:\.000)?$/i.test(normalized)) return false;
  return !Number.isNaN(new Date(/Z$/i.test(normalized) || /[+-]\d{2}:\d{2}$/i.test(normalized) ? normalized : `${normalized}+03:00`).getTime());
}

function resolveMtsSection(details, fallbackSection) {
  return details?.category?.alias || fallbackSection || "events";
}

function resolveYandexSection(url, fallbackSection) {
  const slug = match(String(url || ""), /\/kazan\/([^/?#]+)/i)?.toLowerCase();
  return slug || fallbackSection || "events";
}

function toMoscowIsoFromDateText(dateText, timeText = "") {
  const matchDate = String(dateText || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!matchDate) return null;

  const day = Number(matchDate[1]);
  const month = Number(matchDate[2]) - 1;
  const year = Number(matchDate[3]);
  const timeMatch = String(timeText || "").match(/^(\d{1,2}):(\d{2})$/);
  const hour = timeMatch ? Number(timeMatch[1]) : 12;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  return toMoscowIso(year, month, day, hour, minute);
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

  const keywordScore = Object.values(scores).reduce((sum, score) => sum + score, 0);

  return {
    ...item,
    categories: [...new Set([...(item.categories || []), ...categories])],
    eventDate: item.eventDate || extractEventDateSafe(item),
    eventHasExplicitTime: item.eventHasExplicitTime || hasExplicitEventTime(item),
    baseScore: item.baseScore || keywordScore,
    score: item.score || item.baseScore || keywordScore
  };
}

function extractEventDateSafe(item, now = new Date()) {
  return extractEventDate(item, now);
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

function isAllowedEventItem(item, env, filters = buildEventFilters(new URLSearchParams(), env)) {
  if (!item || shouldRejectEventItem(item)) return false;
  const date = item.eventDate ? new Date(item.eventDate) : null;
  if (!date || Number.isNaN(date.getTime())) return false;
  if (date < filters.from || date > filters.to) return false;
  if (item.eventHasExplicitTime && date < new Date()) return false;
  return true;
}

function matchesEventCategory(item, category = "all") {
  if (!category || category === "all") return true;

  if (category === "expected") {
    return (item.sourceCount || 1) > 1 || (item.priorityScore || item.score || 0) >= 80;
  }

  if (category === "festival") {
    return item.kind === "festival" || isFestivalEventItem(item);
  }

  return item.kind === category;
}

function isFestivalEventItem(item) {
  const haystack = normalizeFingerprintTextSafe([
    item?.title || "",
    item?.summary || "",
    item?.shortSummary || "",
    item?.sourceName || "",
    item?.url || ""
  ].join(" "));

  return haystack.includes("фестив") || haystack.includes("festival");
}

function normalizeExternalImportMode(value) {
  return ["replace_source", "replace", "reconcile"].includes(String(value || "").toLowerCase())
    ? "replace_source"
    : "merge";
}

function pruneExpiredEventItems(items, now = new Date()) {
  return (items || []).filter((item) => !isExpiredEventItem(item, now));
}

function isExpiredEventItem(item, now = new Date()) {
  const date = item?.eventDate ? new Date(item.eventDate) : null;
  if (!date || Number.isNaN(date.getTime())) return true;

  if (item.eventHasExplicitTime) {
    return date < now;
  }

  const endOfDay = parseDateInput(formatDateInput(date), true);
  if (!endOfDay) return true;
  return endOfDay < now;
}

function getAllowedEventWindow(env) {
  const today = getStartOfCurrentMoscowDay();
  const fallbackFrom = today;
  const fallbackTo = getEndOfCurrentMoscowYear(today);
  return {
    from: new Date(env.EVENTS_ALLOWED_FROM || fallbackFrom),
    to: new Date(env.EVENTS_ALLOWED_TO || fallbackTo)
  };
}

function getAllowedEventWindowLabel(env) {
  const { from, to } = getAllowedEventWindow(env);
  return `${formatMoscowDate(from)} - ${formatMoscowDate(to)}`;
}

function buildEventFilters(searchParams, env) {
  const allowed = getAllowedEventWindow(env);
  const defaultFrom = maxDate(allowed.from, getStartOfCurrentMoscowDay());
  const defaultTo = allowed.to;
  const customFrom = parseDateInput(searchParams.get("dateFrom"));
  const customTo = parseDateInput(searchParams.get("dateTo"), true);
  const from = maxDate(defaultFrom, customFrom || defaultFrom);
  let to = minDate(allowed.to, customTo || defaultTo);
  if (to < from) to = from;
  return {
    category: searchParams.get("category") || "all",
    allowedFrom: allowed.from,
    allowedTo: allowed.to,
    defaultFrom,
    defaultTo,
    from,
    to
  };
}

function formatEventFilterLabel(filters) {
  return `${formatMoscowDayMonth(filters.from)} - ${formatMoscowDayMonth(filters.to)}`;
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

function attachTicketLinksSafe(item) {
  return attachTicketLinks(item);
}

function applySafeEventCopy(item) {
  const rawSummary = cleanEventSummary(item.rawSummary || item.summary || item.shortSummary || "");
  const normalized = {
    ...item,
    title: buildShortEventTitleSafe(item.title || item.summary || "Событие"),
    rawSummary,
    imageUrl: item.imageUrl || item.externalPreviewUrl || null,
    externalPreviewUrl: item.externalPreviewUrl || item.imageUrl || null,
    previewOrigin: item.previewOrigin || "source"
  };

  return {
    ...normalized,
    summary: buildSafeEventSummarySafe(normalized),
    shortSummary: buildSafeEventShortSummarySafe(normalized)
  };
}

function buildSafeEventSummary(item) {
  return [
    buildSafeEventDetailLineSafe(item),
    buildSafeEventScheduleLineSafe(item),
    item.kind === "sport"
      ? "Подойдет для живой атмосферы, если хочется пойти на матч и заранее понять логистику."
      : buildSafeEventMoodLineSafe(item),
    "Подробности, программу и билеты лучше открыть у официального источника по ссылке ниже."
  ].filter(Boolean).join("\n\n");
}

function buildSafeEventShortSummary(item) {
  const compact = [
    buildSafeEventDetailLineSafe(item),
    buildSafeEventScheduleLineSafe(item)
  ].filter(Boolean).join(" ");

  return trim(compact || "Подробности и билеты доступны у источника.", 190);
}

function buildSafeEventHeadlineSafe(item) {
  const kindLabel = (item.kind === "sport" ? "Спортивное событие" : eventKindLabelSafe(item.kind)).toLowerCase();
  const shortTitle = quoteEventTitleSafe(buildShortEventTitleSafe(item.title || item.summary || "Событие"));
  return shortTitle ? `В афише Казани — ${kindLabel} ${shortTitle}.` : `В афише Казани — ${kindLabel}.`;
}

function buildSafeEventScheduleLineSafe(item) {
  const eventDate = item.eventDate ? new Date(item.eventDate) : null;
  const hasValidDate = eventDate && !Number.isNaN(eventDate.getTime());
  const venueTitle = normalizeText(item.venueTitle || "");

  if (!hasValidDate && !venueTitle) return "Точное расписание лучше заранее проверить у площадки или организатора.";
  if (!hasValidDate) return `Площадка: ${venueTitle}.`;

  const dateLabel = formatMoscowDate(eventDate);
  const timeLabel = item.eventHasExplicitTime ? formatMoscowTime(eventDate) : "";

  if (venueTitle && timeLabel) return `Дата и место: ${dateLabel}, ${timeLabel}, ${venueTitle}.`;
  if (venueTitle) return `Дата и место: ${dateLabel}, ${venueTitle}.`;
  if (timeLabel) return `Дата: ${dateLabel}, ${timeLabel}.`;
  return `Дата: ${dateLabel}.`;
}

function buildSafeEventDetailLine(item) {
  const detail = extractSafeEventHighlight(item);
  const prefix = {
    concert: "В программе",
    theatre: "В центре вечера",
    show: "Главное в программе",
    festival: "В программе",
    standup: "По формату",
    exhibition: "Внутри",
    excursion: "На маршруте",
    musical: "В постановке",
    kids: "Формат события",
    sport: "В афише матча"
  }[item.kind] || "Главное";

  if (!detail) return buildEventSpecificFallbackLineSafe(item);

  return ensureSentence(`${prefix}: ${detail}`);
}

function buildEventSpecificFallbackLineSafe(item) {
  const kindLabel = item.kind === "sport" ? "Спортивное событие" : eventKindLabelSafe(item.kind);
  const title = buildShortEventTitleSafe(item.title || item.summary || "событие");
  const venueTitle = normalizeText(item.venueTitle || "");
  const eventDate = item.eventDate ? new Date(item.eventDate) : null;
  const dateLabel = eventDate && !Number.isNaN(eventDate.getTime()) ? formatMoscowDayMonth(eventDate) : "";
  const quotedTitle = quoteEventTitleSafe(title);

  if (venueTitle && dateLabel) return `${kindLabel} ${quotedTitle} пройдёт ${dateLabel} на площадке ${venueTitle}.`;
  if (venueTitle) return `${kindLabel} ${quotedTitle} пройдёт на площадке ${venueTitle}.`;
  if (dateLabel) return `${kindLabel} ${quotedTitle} запланирован на ${dateLabel}.`;
  return `${kindLabel} ${quotedTitle} можно рассмотреть как один из вариантов выхода в Казани.`;
}

function extractSafeEventHighlight(item) {
  const sourceText = cleanEventSummary(item.rawSummary || item.subtitle || item.summary || "");
  if (!sourceText) return "";

  const title = buildShortEventTitleSafe(item.title || item.summary || "");
  const titleFingerprint = normalizeFingerprintTextSafe(title);
  const titlePattern = title ? new RegExp(escapeRegExp(title), "giu") : null;
  const sentences = sourceText
    .match(/[^.!?]+[.!?]?/g)
    ?.map((part) => part.trim())
    .filter(Boolean) || [];

  for (const sentence of sentences) {
    const cleaned = sanitizeSafeEventHighlight(sentence, {
      titlePattern,
      venueTitle: item.venueTitle || ""
    });
    if (!cleaned) continue;
    const cleanedFingerprint = normalizeFingerprintTextSafe(cleaned);
    if (titleFingerprint && cleanedFingerprint === titleFingerprint) continue;
    return cleaned;
  }

  return sanitizeSafeEventHighlight(sourceText, {
    titlePattern,
    venueTitle: item.venueTitle || ""
  });
}

function sanitizeSafeEventHighlight(value, options = {}) {
  const titlePattern = options.titlePattern || null;
  const venueTitle = normalizeText(options.venueTitle || "");
  const venuePattern = venueTitle ? new RegExp(escapeRegExp(venueTitle), "giu") : null;

  const originalText = normalizeText(String(value || ""));
  let text = originalText
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/читать полностью.*$/giu, "")
    .replace(/подробнее.*$/giu, "")
    .replace(/купить билеты.*$/giu, "")
    .replace(/покупайте билеты онлайн.*$/giu, "")
    .replace(/удобная схема зала.*$/giu, "")
    .replace(/описание, даты проведения и фотографии.*$/giu, "")
    .replace(/фото, описание.*$/giu, "")
    .replace(/на Яндекс Афише.*$/giu, "")
    .replace(/на МТС Live.*$/giu, "")
    .replace(/в Казани на Яндекс Афише.*$/giu, "")
    .replace(/^источник:\s*/giu, "")
    .replace(/^официальный матч[^:]*:\s*/giu, "")
    .replace(/^билеты на\s+/giu, "")
    .trim();

  const cleanedWithoutEntities = text;

  if (titlePattern) {
    text = text.replace(titlePattern, "").trim();
  }

  text = text
    .replace(/^\([^)]{1,40}\)\s*[—–-]?\s*/u, "")
    .replace(/^\(?г\.\s*[А-ЯЁA-Z][^)]{1,30}\)?\s*[—–-]?\s*/u, "")
    .replace(/^[А-ЯЁA-Z][^)]{1,30}\)\s*[—–-]?\s*/u, "");

  if (venuePattern) {
    text = text.replace(venuePattern, "").trim();
  }

  text = text
    .replace(/^[—–\-:;,.\s]+/u, "")
    .replace(/[—–\-:;,.\s]+$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length < 24) {
    text = cleanedWithoutEntities
      .replace(/^[—–\-:;,.\s]+/u, "")
      .replace(/[—–\-:;,.\s]+$/u, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  const fingerprint = normalizeFingerprintTextSafe(text);
  if (!text || text.length < 24) {
    const fallback = trim(originalText, 176);
    return fallback.length >= 24 ? fallback : "";
  }
  if (text.length > 180) text = trim(text, 176);
  if (!fingerprint) return "";
  if (/^(подробности|источник|билеты|описание)$/iu.test(text)) return "";
  if (/^(дата|место|площадка|адрес|когда|где)\s*:/iu.test(text)) return "";
  if (/яндекс афиш|mts live|удобная схема зала|покупайте билеты онлайн/iu.test(text)) return "";

  return text;
}

function buildSafeEventMoodLineSafe(item) {
  return {
    concert: "Подойдет для вечернего выхода, если хочется живого выступления и понятной логистики.",
    theatre: "Хороший вариант для спокойного вечера и сценического формата без лишнего шума.",
    show: "Подойдет тем, кто ищет более яркий и визуальный формат отдыха в городе.",
    standup: "Можно добавить в план для легкого вечернего выхода с друзьями или вдвоем.",
    exhibition: "Удобный вариант, если хочется спокойного культурного маршрута в своем темпе.",
    excursion: "Подойдет тем, кто хочет узнать город или тему глубже и провести время содержательно.",
    musical: "Хороший выбор для тех, кто любит сцену, музыку и большой постановочный формат.",
    kids: "Можно рассмотреть как семейный выход, если нужен понятный формат на свободный день."
  }[item.kind] || "Можно добавить в личный план, если хочется собрать насыщенный выход по городу.";
}

function buildCustomSafeEventSummary(item) {
  const moodLine = item.kind === "sport"
    ? "Подойдёт для живой атмосферы, если хочется заранее понять формат матча и логистику вечера."
    : buildSafeEventMoodLineSafe(item);

  return [
    buildSafeEventDetailLineSafe(item),
    buildSafeEventScheduleLineSafe(item),
    moodLine,
    "Полные условия посещения и билеты лучше проверить по ссылке в источнике."
  ].filter(Boolean).join("\n\n");
}

function buildCustomSafeEventShortSummary(item) {
  const compact = [
    buildSafeEventDetailLineSafe(item),
    buildSafeEventScheduleLineSafe(item)
  ].filter(Boolean).join(" ");

  return trim(compact || "Короткая карточка события доступна внутри.", 190);
}

function applySafeEventCopySafe(item) {
  return applySafeEventCopy(item);
}

function buildSafeEventSummarySafe(item) {
  return buildCustomSafeEventSummary(item);
}

function buildSafeEventShortSummarySafe(item) {
  return buildCustomSafeEventShortSummary(item);
}

function buildSafeEventDetailLineSafe(item) {
  return buildSafeEventDetailLine(item);
}

function buildShortEventTitleSafe(value) {
  return buildShortEventTitle(value);
}

function quoteEventTitleSafe(value) {
  return quoteEventTitle(value);
}

function eventKindLabelSafe(kind) {
  return eventKindLabel(kind);
}

function buildShortEventTitle(value) {
  const cleaned = normalizeText(String(value || ""))
    .replace(/^билеты на\s+/iu, "")
    .replace(/\s+—\s+яндекс.*$/iu, "")
    .replace(/\s+на Яндекс Афише.*$/iu, "")
    .replace(/\s+на МТС Live.*$/iu, "")
    .replace(/^\d{1,2}[.:]\d{2}\s*/u, "")
    .replace(/^\d{1,2}\s+[а-яё]+\s*/iu, "")
    .replace(/^(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер-?класс)\s+/iu, "")
    .trim();

  return trim(cleaned, 96);
}

function quoteEventTitle(value) {
  const title = normalizeText(value);
  if (!title) return "";
  if (/^[«"][^«»"]+[»"]$/u.test(title)) return title;
  if (/[«»"]/u.test(title)) return title;
  return `«${title}»`;
}

function eventKindLabel(kind) {
  return {
    concert: "Концерт",
    theatre: "Спектакль",
    show: "Шоу",
    festival: "Фестиваль",
    standup: "Стендап",
    exhibition: "Выставка",
    excursion: "Экскурсия",
    musical: "Мюзикл",
    kids: "Детское событие"
  }[kind] || "Событие";
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
  const draftIdentity = buildDraftCandidateIdentity(item);
  const draft = {
    id: cryptoRandomId(),
    itemId: item.id,
    title: item.title,
    text: formatChannelPost(item),
    url: item.url,
    photoUrl: buildChannelPhotoUrl(item, env),
    photoKey: buildDraftPhotoIdentity(item),
    kind: item.kind || "event",
    eventDate: item.eventDate || null,
    eventSignature: draftIdentity.primary,
    eventExactSignature: draftIdentity.exact,
    eventLooseSignature: draftIdentity.loose,
    dateKey: draftIdentity.dateKey,
    titleKey: draftIdentity.titleKey,
    venueKey: draftIdentity.venueKey,
    summaryKey: draftIdentity.summaryKey,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  publishing.drafts.unshift(draft);
  await putJson(env, "publishing", publishing);
  return draft;
}

async function sendDraftPostLegacy(env, chatId, draft, replyMarkup = null) {
  const resolvedDraft = await hydrateDraftForSend(env, draft);
  const photoUrl = resolvedDraft.photoUrl || buildChannelPhotoUrl(resolvedDraft, env);
  const caption = trimTelegramCaption(resolvedDraft.text || "");

  if (photoUrl) {
    await telegramApi(env, "sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      reply_markup: replyMarkup || undefined
    });
    return;
  }

  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: caption,
    disable_web_page_preview: false,
    reply_markup: replyMarkup || undefined
  });
}

async function hydrateDraftForSend(env, draft) {
  if (!draft?.itemId) return draft;

  const items = await getJson(env, "events:items", []);
  const item = items.find((entry) => entry.id === draft.itemId);
  if (!item) return draft;

  return {
    ...draft,
    title: item.title || draft.title,
    text: formatChannelPost(item),
    url: item.url || draft.url,
    photoUrl: buildChannelPhotoUrl(item, env) || draft.photoUrl,
    photoKey: buildDraftPhotoIdentity(item) || draft.photoKey || ""
  };
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
  if (status === "published" && draft.itemId) {
    if (!publishing.postedItemIds.includes(draft.itemId)) {
      publishing.postedItemIds.push(draft.itemId);
    }
    publishing.postedItems = (publishing.postedItems || []).filter((item) => item.itemId !== draft.itemId);
    publishing.postedItems.unshift({
      itemId: draft.itemId,
      draftId,
      postedAt: draft.updatedAt,
      eventSignature: draft.eventSignature || "",
      eventExactSignature: draft.eventExactSignature || "",
      eventLooseSignature: draft.eventLooseSignature || "",
      dateKey: draft.dateKey || "",
      titleKey: draft.titleKey || "",
      venueKey: draft.venueKey || "",
      summaryKey: draft.summaryKey || "",
      photoKey: draft.photoKey || ""
    });
  }
  await putJson(env, "publishing", publishing);
  return draft;
}

function formatChannelPostLegacy(item) {
  const eventDate = item.eventDate ? new Date(item.eventDate) : null;
  const when = eventDate && !Number.isNaN(eventDate.getTime()) ? formatChannelDateLabel(eventDate, item.eventHasExplicitTime) : "дату уточняйте у организатора";
  const paragraphs = buildSafeEventSummary(item)
    .split(/\n{2,}/)
    .map((part) => trim(part, 220))
    .filter(Boolean);

  return [
    buildShortEventTitle(item.title || "Событие в Казани") || "Событие в Казани",
    "",
    `Когда: ${when}`,
    item.venueTitle ? `Где: ${item.venueTitle}` : null,
    "",
    ...paragraphs,
    "",
    item.url ? `Подробнее у источника: ${item.url}` : null
  ].filter(Boolean).join("\n");
}

function normalizePublishingState(publishing) {
  return {
    drafts: Array.isArray(publishing?.drafts) ? publishing.drafts : [],
    postedItemIds: Array.isArray(publishing?.postedItemIds) ? publishing.postedItemIds : [],
    postedItems: Array.isArray(publishing?.postedItems) ? publishing.postedItems : [],
    lastDraftBatchAt: publishing?.lastDraftBatchAt || null,
    lastDraftBatchCount: Math.max(0, Number(publishing?.lastDraftBatchCount || 0) || 0),
    staleDraftsExpired: 0
  };
}

function selectDraftCandidates(candidates, publishing, limit, env) {
  const selected = [];
  const selectedIds = new Set();
  const selectedPhotoKeys = new Set();
  const tiers = buildDraftSelectionCooldowns(env);

  for (const cooldownDays of tiers) {
    const tierCandidates = candidates.filter((item) => {
      if (selectedIds.has(item.id)) return false;
      if (hasPendingDraft(publishing, item)) return false;
      if (isAlreadySelectedDraftCandidate(selected, item)) return false;
      if (isAlreadySelectedDraftPhoto(selectedPhotoKeys, item)) return false;
      if (cooldownDays > 0 && wasRecentlyPosted(publishing, item, env, cooldownDays)) return false;
      return true;
    });
    addDraftCandidatesByKind(tierCandidates, selected, selectedIds, selectedPhotoKeys, limit);
    if (selected.length >= limit) return selected;
  }

  return selected;
}

function hasPendingDraft(publishing, item) {
  const identity = buildDraftCandidateIdentity(item);
  return publishing.drafts.some((draft) => draft.status === "pending" && matchesStoredDraftIdentity(draft, item?.id, identity));
}

function addDraftCandidatesByKind(candidates, selected, selectedIds, selectedPhotoKeys, limit) {
  const preferredKinds = ["concert", "sport", "excursion", "theatre", "show", "standup", "exhibition", "musical", "kids"];

  for (const kind of preferredKinds) {
    const match = candidates.find((item) => (
      item.kind === kind
      && !selectedIds.has(item.id)
      && !isAlreadySelectedDraftCandidate(selected, item)
      && !isAlreadySelectedDraftPhoto(selectedPhotoKeys, item)
    ));
    if (!match) continue;
    addSelectedDraftCandidate(match, selected, selectedIds, selectedPhotoKeys);
    if (selected.length >= limit) return;
  }

  for (const item of candidates) {
    if (selectedIds.has(item.id)) continue;
    if (isAlreadySelectedDraftCandidate(selected, item)) continue;
    if (isAlreadySelectedDraftPhoto(selectedPhotoKeys, item)) continue;
    addSelectedDraftCandidate(item, selected, selectedIds, selectedPhotoKeys);
    if (selected.length >= limit) return;
  }
}

function addSelectedDraftCandidate(item, selected, selectedIds, selectedPhotoKeys) {
  selected.push(item);
  if (item.id) selectedIds.add(item.id);

  const photoKey = buildDraftPhotoIdentity(item);
  if (photoKey) selectedPhotoKeys.add(photoKey);
}

function isAlreadySelectedDraftPhoto(selectedPhotoKeys, item) {
  if (!(selectedPhotoKeys instanceof Set)) return false;

  const photoKey = buildDraftPhotoIdentity(item);
  return Boolean(photoKey && selectedPhotoKeys.has(photoKey));
}

function buildDraftPhotoIdentity(item) {
  if (!item || typeof item !== "object") return "";

  const recurringVisualKey = [
    normalizeComparableEntity(item.title || item.summary || ""),
    normalizeComparableVenue(item.venueTitle || ""),
    normalizeComparableEntity(item.kind || "event")
  ].filter(Boolean).join("|");

  if (recurringVisualKey) return `event-visual:${recurringVisualKey}`;

  const previewKey = buildEventPreviewKey(item);
  if (previewKey) return `preview:${previewKey}`;

  const directImage = firstChannelImageUrl(item);
  if (directImage) return `source-image:${directImage}`;

  return item.id ? `item:${item.id}` : "";
}

function wasRecentlyPosted(publishing, item, env, overrideDays = null) {
  const cooldownDays = overrideDays != null
    ? Number(overrideDays)
    : Number(env.DRAFT_REPOST_COOLDOWN_DAYS || 14);
  const identity = buildDraftCandidateIdentity(item);
  const posted = (publishing.postedItems || []).find((postedItem) => matchesStoredDraftIdentity(postedItem, item?.id, identity));
  if (!posted?.postedAt) return false;

  const postedTime = new Date(posted.postedAt).getTime();
  if (Number.isNaN(postedTime)) return false;

  return (Date.now() - postedTime) < (cooldownDays * 24 * 60 * 60 * 1000);
}

function buildDraftSelectionCooldowns(env) {
  const values = [
    Number(env.DRAFT_REPOST_COOLDOWN_DAYS || 4),
    Number(env.DRAFT_REPOST_SOFT_COOLDOWN_DAYS || 2),
    1,
    1,
    0
  ];

  const seen = new Set();
  return values
    .map((value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0))
    .filter((value) => {
      const key = String(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildDraftCandidateIdentity(item) {
  const exact = buildExactEventSignature(item);
  const loose = buildLooseEventSignature(item);
  const dateKey = formatDateInput(item?.eventDate);
  const titleKey = normalizeComparableEntity(item?.title);
  const venueKey = normalizeComparableVenue(item?.venueTitle);
  const summaryKey = buildComparableSummaryKey(item);
  const fallback = [dateKey, titleKey, venueKey, summaryKey].filter(Boolean).join(":");

  return {
    primary: loose || exact || (fallback ? `draft:${fallback}` : ""),
    exact,
    loose,
    dateKey,
    titleKey,
    venueKey,
    summaryKey
  };
}

function matchesStoredDraftIdentity(stored, itemId, identity) {
  if (!stored || typeof stored !== "object") return false;
  if (itemId && stored.itemId === itemId) return true;

  const storedSignatures = [
    stored.eventSignature,
    stored.eventLooseSignature,
    stored.eventExactSignature
  ].filter(Boolean);

  if (identity?.primary && storedSignatures.includes(identity.primary)) return true;
  if (identity?.loose && storedSignatures.includes(identity.loose)) return true;
  if (identity?.exact && storedSignatures.includes(identity.exact)) return true;

  if (!identity?.dateKey || !identity?.titleKey || !identity?.venueKey) return false;
  if (stored.dateKey !== identity.dateKey || stored.titleKey !== identity.titleKey || stored.venueKey !== identity.venueKey) {
    return false;
  }

  if (!stored.summaryKey || !identity.summaryKey) return true;
  return stored.summaryKey === identity.summaryKey;
}

function isAlreadySelectedDraftCandidate(selected, candidate) {
  if (!Array.isArray(selected) || !candidate) return false;
  const candidateIdentity = buildDraftCandidateIdentity(candidate);

  return selected.some((current) => {
    if (!current) return false;
    if (current.id && candidate.id && current.id === candidate.id) return true;

    const currentIdentity = buildDraftCandidateIdentity(current);
    if (candidateIdentity.primary && currentIdentity.primary && candidateIdentity.primary === currentIdentity.primary) {
      return true;
    }

    if (candidateIdentity.loose && currentIdentity.loose && candidateIdentity.loose === currentIdentity.loose) {
      return true;
    }

    return areLikelySameEvent(current, candidate);
  });
}

function splitDraftParagraphs(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const sentences = normalized
    .match(/[^.!?]+[.!?]?/g)
    ?.map((part) => part.trim())
    .filter(Boolean) || [];

  if (sentences.length <= 1) return [normalized];

  return [
    sentences[0],
    sentences.slice(1, 3).join(" ").trim()
  ].filter(Boolean);
}

function buildChannelPhotoUrlLegacy(item, env) {
  const assetPath = channelImagePathForKind(item.kind);

  for (const baseUrl of channelPhotoBaseUrls(env)) {
    try {
      return new URL(assetPath, baseUrl).toString();
    } catch {
      continue;
    }
  }

  return "";
}

function channelImagePathForKind(kind) {
  return {
    food: "brand/section-food.png",
    route: "brand/section-routes.png",
    roadtrip: "brand/section-routes.png",
    active: "brand/section-events.png",
    excursion: "brand/section-routes.png",
    exhibition: "brand/section-parks.png",
    kids: "brand/welcome-kazan-event-radar-640x360.png"
  }[kind] || "brand/section-events.png";
}

function channelPhotoBaseUrls(env) {
  const candidates = [];
  const miniAppUrl = normalizeBaseUrl(env.MINI_APP_URL);

  if (miniAppUrl) {
    candidates.push(miniAppUrl);

    try {
      const parsed = new URL(miniAppUrl);
      if (!/\/miniapp\/?$/i.test(parsed.pathname)) {
        candidates.push(new URL("miniapp/", miniAppUrl).toString());
      }
    } catch {
      // Ignore malformed env values and keep other fallbacks.
    }
  }

  candidates.push("https://raw.githubusercontent.com/cherreshenka1/kazan-event-radar/main/public/miniapp/");
  candidates.push("https://cherreshenka1.github.io/kazan-event-radar/miniapp/");

  return [...new Set(candidates)];
}

function normalizeBaseUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function trimTelegramCaption(value, maxLength = 1000) {
  return trim(value, maxLength);
}

function extractTelegramImageUrl(chunk) {
  const style = match(chunk, /tgme_widget_message_photo_wrap[^>]+style="([^"]+)"/)
    || match(chunk, /tgme_widget_message_link_preview[^>]+style="([^"]+)"/);

  if (!style) return null;

  const urlMatch = style.match(/url\(['"]?([^'")]+)['"]?\)/);
  return urlMatch?.[1] || null;
}

async function sendDraftPost(env, chatId, draft, replyMarkup = null) {
  const resolvedDraft = await hydrateDraftForSend(env, draft);
  const caption = trimTelegramCaption(resolvedDraft.text || "");
  const photoCandidates = await resolveChannelPhotoCandidates(resolvedDraft, env);

  for (const photoUrl of photoCandidates) {
    try {
      await telegramApi(env, "sendPhoto", {
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup || undefined
      });
      return;
    } catch (error) {
      console.warn(`Failed to send draft preview ${photoUrl}: ${error.message}`);
    }
  }

  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup || undefined
  });
}

function formatChannelPost(item) {
  const eventDate = item.eventDate ? new Date(item.eventDate) : null;
  const title = buildShortEventTitleSafe(item.title || item.summary || "Событие в Казани") || "Событие в Казани";
  const when = eventDate && !Number.isNaN(eventDate.getTime())
    ? `Когда: ${formatChannelDateLabel(eventDate, item.eventHasExplicitTime)}`
    : "Когда: дату уточняйте у организатора";
  const where = item.venueTitle ? `Где: ${normalizeText(item.venueTitle)}` : "";
  const metaBlock = [when, where].filter(Boolean).map((line) => escapeHtml(line)).join("\n");
  const paragraphs = buildChannelPostParagraphs(item).map((part) => escapeHtml(part));
  const sourceLine = item.url ? `<a href="${escapeHtml(item.url)}">Источник</a>` : "";

  return [
    `<b>${escapeHtml(title)}</b>`,
    metaBlock,
    ...paragraphs,
    sourceLine
  ].filter(Boolean).join("\n\n");
}

function buildChannelPostParagraphs(item) {
  const paragraphs = [];
  const detailLine = buildSafeEventDetailLineSafe(item);

  if (detailLine) {
    paragraphs.push(trim(detailLine, 220));
  }

  const moodLine = item.kind === "sport"
    ? "Подойдет для живой атмосферы, если хочется пойти на матч и заранее понять логистику."
    : buildSafeEventMoodLineSafe(item);

  if (moodLine && !paragraphs.some((entry) => normalizeFingerprintTextSafe(entry) === normalizeFingerprintTextSafe(moodLine))) {
    paragraphs.push(trim(moodLine, 220));
  }

  const fallbackText = cleanEventSummary(item.rawSummary || item.summary || item.shortSummary || item.subtitle || "");
  if (paragraphs.length < 2 && fallbackText) {
    for (const part of splitDraftParagraphs(fallbackText)) {
      const normalized = sanitizeSafeEventHighlight(part, {
        titlePattern: buildShortEventTitleSafe(item.title || item.summary || "")
          ? new RegExp(escapeRegExp(buildShortEventTitleSafe(item.title || item.summary || "")), "giu")
          : null,
        venueTitle: item.venueTitle || ""
      });
      if (!normalized) continue;
      if (paragraphs.some((entry) => normalizeFingerprintTextSafe(entry) === normalizeFingerprintTextSafe(normalized))) continue;
      paragraphs.push(trim(ensureSentence(normalized), 220));
      if (paragraphs.length >= 3) break;
    }
  }

  return paragraphs.slice(0, 3);
}

function buildChannelPhotoUrl(item, env) {
  const generatedPreviewUrl = buildGeneratedChannelPhotoUrl(item, env);
  if (generatedPreviewUrl) return generatedPreviewUrl;

  const assetPath = channelImagePathForKind(item.kind);

  for (const baseUrl of channelPhotoBaseUrls(env)) {
    try {
      return new URL(assetPath, baseUrl).toString();
    } catch {
      continue;
    }
  }

  return "";
}

async function resolveChannelPhotoCandidates(item, env) {
  const candidates = [];

  for (const generatedPreviewUrl of buildGeneratedChannelPhotoUrls(item, env)) {
    if (await remoteAssetExists(generatedPreviewUrl)) {
      candidates.push(generatedPreviewUrl);
      break;
    }
  }

  if (String(env.CHANNEL_ALLOW_SOURCE_IMAGES || "").trim() === "1") {
    const directPhotoUrl = buildChannelDirectPhotoUrl(item, env);
    if (directPhotoUrl) {
      candidates.push(directPhotoUrl);
    }
  }

  const fallbackPhotoUrl = buildFallbackChannelPhotoUrl(item, env);
  if (fallbackPhotoUrl) {
    candidates.push(fallbackPhotoUrl);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function buildGeneratedChannelPhotoUrl(item, env) {
  return buildGeneratedChannelPhotoUrls(item, env)[0] || "";
}

function buildGeneratedChannelPhotoUrls(item, env) {
  const previewPath = generatedEventPreviewPath(item);
  if (!previewPath) return [];
  const urls = [];

  for (const baseUrl of channelPhotoBaseUrls(env)) {
    try {
      urls.push(new URL(previewPath, baseUrl).toString());
    } catch {
      continue;
    }
  }

  return [...new Set(urls)];
}

function buildFallbackChannelPhotoUrl(item, env) {
  const assetPath = channelImagePathForKind(item.kind);

  for (const baseUrl of channelPhotoBaseUrls(env)) {
    try {
      return new URL(assetPath, baseUrl).toString();
    } catch {
      continue;
    }
  }

  return "";
}

function buildChannelDirectPhotoUrl(item, env) {
  const directUrl = firstChannelImageUrl(item);
  if (!directUrl) return "";

  const apiBase = normalizeBaseUrl(env.PUBLIC_API_URL || "https://kazan-event-radar-api.4ereshny333.workers.dev");
  if (!apiBase) return directUrl;

  try {
    return new URL(`api/image?url=${encodeURIComponent(directUrl)}`, apiBase).toString();
  } catch {
    return directUrl;
  }
}

function firstChannelImageUrl(item) {
  const candidates = [
    item?.imageUrl,
    item?.photoUrl,
    ...(Array.isArray(item?.photoLinks) ? item.photoLinks.map((link) => link?.url) : [])
  ];

  return candidates.find((value) => /^https?:\/\//i.test(String(value || "").trim())) || "";
}

function generatedEventPreviewPath(item) {
  const previewKey = buildEventPreviewKey(item);
  if (!previewKey) return "";
  return `generated/events/${previewKey}.jpg`;
}

function buildEventPreviewKey(item) {
  const dateKey = formatDateInput(item?.eventDate) || "undated";
  const titleKey = normalizeEventPreviewEntity(item?.title || item?.summary || item?.shortSummary || "");
  const venueKey = normalizeEventPreviewVenue(item?.venueTitle || "");
  const kindKey = normalizeEventPreviewEntity(item?.kind || "event");
  const base = [dateKey, titleKey, venueKey, kindKey].filter(Boolean).join("|");
  if (!base) return "";
  return `${dateKey}-${hashEventPreviewKey(base)}`;
}

function hashEventPreviewKey(value) {
  let hash = 2166136261;

  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizeEventPreviewEntity(value) {
  return normalizeFingerprintTextSafe(value)
    .replace(/\b(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер класс|матч|турнир|билеты|казань|афиша)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEventPreviewVenue(value) {
  return normalizeFingerprintTextSafe(value)
    .replace(/\b(г казань|казань|лдс|мвц|крк|дк|кск|арена|концерт холл|пространство|площадка|сцена)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function remoteAssetExists(url) {
  if (!url) return false;

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow"
    });
    if (response.ok) return true;
  } catch {
    // Ignore HEAD failures and try GET below.
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow"
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendMiniAppEntry(chatId, env, text) {
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[{ text: "Открыть афишу", web_app: { url: env.MINI_APP_URL } }]]
    }
  });
}

function formatScanSummary(meta, env) {
  if (!meta) {
    return [
      "Сканирование еще не запускалось.",
      `Период событий: ${getAllowedEventWindowLabel(env)}.`,
      `Активных источников афиши: ${EVENT_SOURCES.length}.`
    ].join("\n");
  }

  const sourceLines = (meta.sources || [])
    .map((source) => `${source.status === "ok" ? "•" : "×"} ${source.name}: ${source.count}`)
    .join("\n");

  return [
    `Последнее обновление: ${meta.lastScanAt ? formatMoscowDateTime(new Date(meta.lastScanAt)) : "неизвестно"}`,
    `Причина запуска: ${meta.reason || "manual"}`,
    `Активных источников: ${meta.enabledSources || EVENT_SOURCES.length}`,
    `Материалов в базе: ${meta.totalItems || 0}`,
    `Событий по окну ${getAllowedEventWindowLabel(env)}: ${meta.eventItems || 0}`,
    sourceLines ? "" : null,
    sourceLines
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

async function requireAutomationToken(request, env) {
  const expectedToken = String(env.AUTOMATION_TOKEN || "").trim();
  if (!expectedToken) throw new HttpError("AUTOMATION_TOKEN is not configured.", 503);

  const authHeader = request.headers.get("authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = String(
    request.headers.get("x-automation-token")
    || request.headers.get("x-internal-token")
    || (bearerMatch ? bearerMatch[1] : "")
  ).trim();

  if (!providedToken || providedToken !== expectedToken) {
    throw new HttpError("Forbidden", 403);
  }
}

function parseBooleanFlag(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }

  return false;
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
  const [eventMeta, eventsRefresh, catalogRefresh] = await Promise.all([
    getEventMeta(env),
    getJson(env, "system:eventsRefreshReport", null),
    getJson(env, "system:catalogRefreshReport", null)
  ]);

  return {
    totalEvents: events.length,
    uniqueUsers: uniqueUsers.size,
    byType: groupCount(events, "type"),
    byAction: groupCount(events, "action"),
    recentEvents: events.slice(-100).reverse(),
    system: {
      updatedAt: new Date().toISOString(),
      eventMeta,
      eventsRefresh,
      catalogRefresh
    }
  };
}

function renderAnalyticsPage(summary) {
  return renderAdminDashboard(summary);
}

async function getEventMeta(env, items = null) {
  const storedMeta = await getJson(env, "events:meta", null);
  if (storedMeta) return storedMeta;

  const cachedItems = items || await getJson(env, "events:items", []);
  if (!cachedItems.length) return null;

  return {
    lastScanAt: cachedItems.find((item) => item.updatedAt)?.updatedAt || null,
    reason: "legacy_cache",
    enabledSources: EVENT_SOURCES.length,
    collectedItems: cachedItems.length,
    totalItems: cachedItems.length,
    eventItems: cachedItems.filter((item) => (item.categories?.includes("events") || item.eventDate) && isAllowedEventItem(item, env)).length,
    sources: []
  };
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
  const publishing = expireStalePendingDrafts(
    normalizePublishingState(await getJson(env, "publishing", {
      drafts: [],
      postedItemIds: [],
      postedItems: [],
      lastDraftBatchAt: null,
      lastDraftBatchCount: 0
    })),
    env
  );

  if (publishing.staleDraftsExpired > 0) {
    await putJson(env, "publishing", {
      drafts: publishing.drafts,
      postedItemIds: publishing.postedItemIds,
      postedItems: publishing.postedItems,
      lastDraftBatchAt: publishing.lastDraftBatchAt,
      lastDraftBatchCount: publishing.lastDraftBatchCount
    });
  }

  return {
    drafts: publishing.drafts,
    postedItemIds: publishing.postedItemIds,
    postedItems: publishing.postedItems,
    lastDraftBatchAt: publishing.lastDraftBatchAt,
    lastDraftBatchCount: publishing.lastDraftBatchCount
  };
}

function getPreparedDraftCountForDate(publishing, value = new Date()) {
  const dateKey = formatDateInput(value);
  if (!dateKey) return 0;

  const batchCount = publishing?.lastDraftBatchAt && formatDateInput(publishing.lastDraftBatchAt) === dateKey
    ? Math.max(0, Number(publishing.lastDraftBatchCount || 0) || 0)
    : 0;

  const draftCount = Array.isArray(publishing?.drafts)
    ? publishing.drafts.filter((draft) => {
      if (!draft || typeof draft !== "object") return false;
      if (!draft.createdAt || formatDateInput(draft.createdAt) !== dateKey) return false;
      return draft.status !== "failed" && draft.status !== "expired";
    }).length
    : 0;

  return Math.max(batchCount, draftCount);
}

function expireStalePendingDrafts(publishing, env, now = new Date()) {
  const ttlHours = Math.max(12, Number(env?.DRAFT_PENDING_TTL_HOURS || 30) || 30);
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const nowTime = now.getTime();
  const nowIso = now.toISOString();
  let staleDraftsExpired = 0;
  const seenPendingDraftKeys = new Set();

  const drafts = publishing.drafts.map((draft) => {
    if (!draft || typeof draft !== "object") return draft;
    if (draft.status !== "pending") return draft;

    const timestamp = draft.updatedAt || draft.createdAt;
    const draftTime = timestamp ? new Date(timestamp).getTime() : Number.NaN;
    if (Number.isNaN(draftTime)) return draft;
    if ((nowTime - draftTime) >= ttlMs) {
      staleDraftsExpired += 1;
      return {
        ...draft,
        status: "expired",
        updatedAt: nowIso
      };
    }

    const identityKeys = [
      draft.itemId ? `item:${draft.itemId}` : "",
      draft.eventExactSignature ? `exact:${draft.eventExactSignature}` : "",
      draft.eventSignature ? `primary:${draft.eventSignature}` : "",
      draft.eventLooseSignature ? `loose:${draft.eventLooseSignature}` : "",
      draft.dateKey && draft.titleKey && draft.venueKey
        ? `basic:${draft.dateKey}:${draft.titleKey}:${draft.venueKey}:${draft.summaryKey || ""}`
        : ""
    ].filter(Boolean);

    const isDuplicatePendingDraft = identityKeys.some((key) => seenPendingDraftKeys.has(key));
    if (isDuplicatePendingDraft) {
      staleDraftsExpired += 1;
      return {
        ...draft,
        status: "expired",
        updatedAt: nowIso
      };
    }

    identityKeys.forEach((key) => seenPendingDraftKeys.add(key));
    return draft;
  });

  return {
    drafts,
    postedItemIds: publishing.postedItemIds,
    postedItems: publishing.postedItems,
    lastDraftBatchAt: publishing.lastDraftBatchAt || null,
    lastDraftBatchCount: Math.max(0, Number(publishing.lastDraftBatchCount || 0) || 0),
    staleDraftsExpired
  };
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

async function fetchText(url, options = {}) {
  const headers = {
    "user-agent": options.userAgent || "Mozilla/5.0 (compatible; KazanEventRadarBot/1.0; +https://t.me/kazanEventRadarBot)",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ru-RU,ru;q=0.9,en;q=0.8"
  };

  if (options.referer) {
    headers.referer = options.referer;
  }

  const response = await fetch(url, { headers, redirect: "follow" });
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
  const stableKey = String(item?.sourceId || "").startsWith("sport-")
    ? `${item.sourceId}:${item.url || ""}:${item.title || ""}:${item.eventDate || ""}`
    : (item.url || `${item.sourceId}:${item.title}:${item.publishedAt || item.eventDate || ""}`);
  return (await sha256(stableKey)).slice(0, 24);
}

async function fingerprintId(fingerprint) {
  return (await sha256(`event:${fingerprint}`)).slice(0, 24);
}

async function hashUser(env, userId) {
  return (await sha256(`${env.ANALYTICS_SALT || env.TELEGRAM_BOT_TOKEN || "kazan-event-radar"}:${userId}`)).slice(0, 16);
}

async function sha256(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
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
  const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...normalized].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function hasExplicitEventTime(item) {
  const text = `${item.title || ""}\n${item.summary || ""}`;
  return /(?:^|\D)([01]?\d|2[0-3])[:.](\d{2})(?:\D|$)/.test(text);
}

async function collapseDuplicateItems(items) {
  const nowIso = new Date().toISOString();
  const grouped = new Map();

  for (const raw of items) {
    const prepared = ensureEventAggregate(raw);
    const directFingerprint = prepared.fingerprint || buildItemFingerprint(prepared);
    const matchedFingerprint = grouped.has(directFingerprint)
      ? directFingerprint
      : findMatchingFingerprint(grouped, prepared);
    const fingerprint = matchedFingerprint || directFingerprint;
    const current = grouped.get(fingerprint);
    grouped.set(fingerprint, mergeDuplicateItems(current, { ...prepared, fingerprint }, nowIso));
  }

  const nextItems = [];
  for (const item of grouped.values()) {
    const finalized = finalizeMergedItem(item);
    finalized.id = finalized.id || await fingerprintId(finalized.fingerprint);
    nextItems.push(finalized);
  }

  return nextItems.sort((a, b) => {
    const updatedDiff = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    if (updatedDiff) return updatedDiff;
    return compareEventPriority(a, b);
  });
}

function ensureEventAggregate(item) {
  const normalized = classifyItem(item);
  const sources = normalizeSourceEntries(item.sources?.length ? item.sources : [item]);
  return {
    ...normalized,
    fingerprint: item.fingerprint || buildItemFingerprint(normalized),
    sourceCount: item.sourceCount || sources.length || 1,
    sourceIds: uniqueStrings([...(item.sourceIds || []), ...sources.map((source) => source.id).filter(Boolean)]),
    sourceNames: uniqueStrings([...(item.sourceNames || []), ...sources.map((source) => source.name).filter(Boolean)]),
    sources,
    duplicateUrls: uniqueStrings([...(item.duplicateUrls || []), item.url, ...sources.map((source) => source.url)]),
    rawSummary: item.rawSummary || item.summary || "",
    shortSummary: item.shortSummary || buildSafeEventShortSummary(normalized),
    priorityScore: item.priorityScore || 0
  };
}

function mergeDuplicateItems(current, candidate, nowIso) {
  if (!current) {
    return {
      ...candidate,
      seenAt: candidate.seenAt || nowIso,
      updatedAt: candidate._seenThisScan ? nowIso : (candidate.updatedAt || nowIso)
    };
  }

  const mergedSources = normalizeSourceEntries([...(current.sources || []), ...(candidate.sources || [])]);
  const candidateUpdatedAt = candidate._seenThisScan ? nowIso : (candidate.updatedAt || current.updatedAt || nowIso);
  const keepCandidateTitle = titleQuality(candidate.title) > titleQuality(current.title);
  const keepCandidateSummary = summaryQuality(candidate.rawSummary || candidate.summary) > summaryQuality(current.rawSummary || current.summary);
  const keepCandidateVenue = textQuality(candidate.venueTitle) > textQuality(current.venueTitle);
  const mergedImageUrl = candidate.imageUrl || current.imageUrl || null;

  return {
    ...current,
    ...candidate,
    id: current.id || candidate.id,
    title: keepCandidateTitle ? candidate.title : current.title,
    summary: keepCandidateSummary ? candidate.summary : current.summary,
    rawSummary: keepCandidateSummary ? (candidate.rawSummary || candidate.summary) : (current.rawSummary || current.summary),
    url: keepCandidateSummary ? (candidate.url || current.url) : (current.url || candidate.url),
    imageUrl: mergedImageUrl,
    venueTitle: keepCandidateVenue ? (candidate.venueTitle || current.venueTitle) : (current.venueTitle || candidate.venueTitle),
    sourceName: keepCandidateTitle ? (candidate.sourceName || current.sourceName) : (current.sourceName || candidate.sourceName),
    categories: uniqueStrings([...(current.categories || []), ...(candidate.categories || [])]),
    sourceIds: uniqueStrings([...(current.sourceIds || []), ...(candidate.sourceIds || []), ...mergedSources.map((source) => source.id)]),
    sourceNames: uniqueStrings([...(current.sourceNames || []), ...(candidate.sourceNames || []), ...mergedSources.map((source) => source.name)]),
    sources: mergedSources,
    duplicateUrls: uniqueStrings([...(current.duplicateUrls || []), ...(candidate.duplicateUrls || []), current.url, candidate.url]),
    sourceCount: mergedSources.length || Math.max(current.sourceCount || 1, candidate.sourceCount || 1),
    eventDate: chooseEventDate(current, candidate),
    eventHasExplicitTime: Boolean(current.eventHasExplicitTime || candidate.eventHasExplicitTime),
    baseScore: Math.max(current.baseScore || 0, candidate.baseScore || 0),
    score: Math.max(current.score || 0, candidate.score || 0),
    shortSummary: buildCompactSummary(keepCandidateSummary ? candidate.summary : current.summary),
    seenAt: current.seenAt || candidate.seenAt || nowIso,
    updatedAt: candidate._seenThisScan ? candidateUpdatedAt : (current.updatedAt || candidateUpdatedAt)
  };
}

function finalizeMergedItem(item) {
  const sourceCount = item.sourceCount || item.sources?.length || 1;
  const priorityScore = (item.baseScore || item.score || 0) + (sourceCount - 1) * 6;
  return applySafeEventCopy({
    ...item,
    sourceCount,
    sourceIds: uniqueStrings([...(item.sourceIds || []), ...normalizeSourceEntries(item.sources || []).map((source) => source.id)]),
    sourceNames: uniqueStrings([...(item.sourceNames || []), ...normalizeSourceEntries(item.sources || []).map((source) => source.name)]),
    sources: normalizeSourceEntries(item.sources || []),
    duplicateUrls: uniqueStrings([...(item.duplicateUrls || []), item.url]),
    rawSummary: item.rawSummary || item.summary || "",
    shortSummary: buildSafeEventShortSummary(item),
    priorityScore
  });
}

function normalizeSourceEntries(sources) {
  const map = new Map();

  for (const source of sources || []) {
    const id = source?.sourceId || source?.id || null;
    const name = source?.sourceName || source?.name || null;
    const url = source?.url || null;
    const key = id || url || name;
    if (!key) continue;
    map.set(key, {
      id,
      name,
      url
    });
  }

  return [...map.values()];
}

function buildItemFingerprint(item) {
  const exactSignature = buildExactEventSignature(item);
  if (exactSignature) return exactSignature;

  const dateKey = item.eventDate ? formatDateInput(item.eventDate) : "undated";
  const quotedTokens = extractQuotedTokens(item.title || item.rawSummary || item.summary || "");
  const titleTokens = quotedTokens.length ? quotedTokens : tokenizeFingerprintSafe(item.title || firstLine(item.rawSummary || item.summary) || "");
  const fallbackTokens = titleTokens.length ? titleTokens : tokenizeFingerprintSafe(item.rawSummary || item.summary || item.url || item.id || "");
  return `${dateKey}:${fallbackTokens.slice(0, 7).sort().join("-") || "event"}`;
}

function tokenizeFingerprintSafe(value) {
  return tokenizeFingerprint(value);
}

function tokenizeFingerprint(value) {
  return [...new Set(
    normalizeFingerprintTextSafe(value)
      .split(" ")
      .filter((token) => token.length >= 3 && !EVENT_FINGERPRINT_STOP_WORDS.has(token))
  )];
}

function normalizeFingerprintTextSafe(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatchingFingerprint(grouped, candidate) {
  for (const [fingerprint, current] of grouped.entries()) {
    if (areLikelySameEvent(current, candidate)) {
      return fingerprint;
    }
  }

  return null;
}

function areLikelySameEvent(current, candidate) {
  if (!current?.eventDate || !candidate?.eventDate) return false;
  if (formatDateInput(current.eventDate) !== formatDateInput(candidate.eventDate)) return false;

  const currentExact = buildExactEventSignature(current);
  const candidateExact = buildExactEventSignature(candidate);
  if (currentExact && candidateExact && currentExact === candidateExact) {
    return true;
  }

  const currentLoose = buildLooseEventSignature(current);
  const candidateLoose = buildLooseEventSignature(candidate);
  if (currentLoose && candidateLoose && currentLoose === candidateLoose) {
    return true;
  }

  if (!areMergeCompatibleKinds(current.kind, candidate.kind)) return false;

  const currentTitleKey = normalizeComparableEntity(current.title);
  const candidateTitleKey = normalizeComparableEntity(candidate.title);
  const currentVenueKey = normalizeComparableVenue(current.venueTitle);
  const candidateVenueKey = normalizeComparableVenue(candidate.venueTitle);
  const summariesMatch = haveMatchingComparableSummaries(current, candidate);
  const bothHaveComparableSummary = hasMeaningfulComparableSummary(current) && hasMeaningfulComparableSummary(candidate);
  const currentSummaryText = normalizeComparableSummaryText(current);
  const candidateSummaryText = normalizeComparableSummaryText(candidate);
  const summaryTextMatch = Boolean(
    currentSummaryText
    && candidateSummaryText
    && (
      currentSummaryText === candidateSummaryText
      || currentSummaryText.includes(candidateSummaryText)
      || candidateSummaryText.includes(currentSummaryText)
    )
  );

  if (currentTitleKey && candidateTitleKey && currentTitleKey === candidateTitleKey) {
    if (!currentVenueKey || !candidateVenueKey) {
      return summariesMatch || summaryTextMatch || !bothHaveComparableSummary;
    }
    if (currentVenueKey === candidateVenueKey) {
      return summariesMatch || summaryTextMatch || !bothHaveComparableSummary;
    }
  }

  const quotedCurrent = extractQuotedTokens(`${current.title || ""} ${current.rawSummary || current.summary || ""}`);
  const quotedCandidate = extractQuotedTokens(`${candidate.title || ""} ${candidate.rawSummary || candidate.summary || ""}`);
  const quotedOverlap = countTokenOverlap(quotedCurrent, quotedCandidate);
  if (quotedCurrent.length && quotedCandidate.length && quotedOverlap >= Math.min(2, quotedCurrent.length, quotedCandidate.length)) {
    return true;
  }

  const currentTitleTokens = tokenizeFingerprint(current.title || "");
  const candidateTitleTokens = tokenizeFingerprint(candidate.title || "");
  const titleOverlap = countTokenOverlap(currentTitleTokens, candidateTitleTokens);
  const titleShortest = Math.max(1, Math.min(currentTitleTokens.length, candidateTitleTokens.length));
  const titleRatio = titleOverlap / titleShortest;

  if (titleOverlap < 2 || titleRatio < 0.74) {
    return false;
  }

  if (!currentVenueKey || !candidateVenueKey) {
    return summariesMatch || summaryTextMatch || !bothHaveComparableSummary;
  }

  if (currentVenueKey === candidateVenueKey) {
    return summariesMatch || summaryTextMatch || !bothHaveComparableSummary;
  }

  const currentVenueTokens = tokenizeFingerprint(current.venueTitle || "");
  const candidateVenueTokens = tokenizeFingerprint(candidate.venueTitle || "");
  const venueOverlap = countTokenOverlap(currentVenueTokens, candidateVenueTokens);
  if (!venueOverlap) return false;
  return summariesMatch || summaryTextMatch || !bothHaveComparableSummary;
}

function areMergeCompatibleKinds(left, right) {
  if (!left || !right) return true;
  return eventKindFamily(left) === eventKindFamily(right);
}

function eventKindFamily(kind) {
  return {
    concert: "concert",
    standup: "standup",
    theatre: "theatre",
    theatre_show: "theatre",
    monoperformance: "theatre",
    show: "show",
    festival: "show",
    circus_show: "show",
    musical: "show",
    kids: "show",
    exhibition: "exhibition",
    art: "exhibition",
    excursion: "excursion",
    excursions: "excursion",
    sport: "sport",
    sports: "sport"
  }[kind] || kind;
}

function buildComparableTokens(item) {
  const text = [
    item.title || "",
    item.venueTitle || "",
    trim(item.rawSummary || item.summary || "", 220)
  ].join(" ");

  return tokenizeFingerprint(text);
}

function buildExactEventSignature(item) {
  const dateKey = formatDateInput(item?.eventDate);
  const titleKey = normalizeComparableEntity(item?.title);
  const venueKey = normalizeComparableVenue(item?.venueTitle);
  if (!dateKey || !titleKey || !venueKey) return "";

  const timeKey = item?.eventHasExplicitTime ? formatTimeKey(item.eventDate) : "no-time";
  return `exact:${dateKey}:${timeKey}:${titleKey}:${venueKey}`;
}

function buildLooseEventSignature(item) {
  const dateKey = formatDateInput(item?.eventDate);
  const titleKey = normalizeComparableEntity(item?.title);
  const venueKey = normalizeComparableVenue(item?.venueTitle);
  const summaryKey = buildComparableSummaryKey(item);
  if (!dateKey || !titleKey || !venueKey || !summaryKey) return "";

  return `loose:${dateKey}:${titleKey}:${venueKey}:${summaryKey}`;
}

function normalizeComparableEntity(value) {
  return normalizeFingerprintTextSafe(value).replace(/\b(концерт|спектакль|шоу|экскурсия|стендап|выставка|мюзикл|лекция|мастер класс)\b/giu, "").trim();
}

function normalizeComparableVenue(value) {
  return normalizeFingerprintTextSafe(value)
    .replace(/\b(лдс|мвц|дк|кц|кз|гбук|гбу|дворец спорта|концерт холл|пространство|площадка|сцена)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildComparableSummaryTokens(item) {
  const detail = extractSafeEventHighlight(item) || cleanEventSummary(item?.rawSummary || item?.summary || item?.shortSummary || "");
  if (!detail) return [];

  const ignoredTokens = new Set([
    ...tokenizeFingerprint(item?.title || ""),
    ...tokenizeFingerprint(item?.venueTitle || "")
  ]);
  const detailTokens = tokenizeFingerprint(detail).filter((token) => !ignoredTokens.has(token));
  return detailTokens.length ? detailTokens : tokenizeFingerprint(detail);
}

function buildComparableSummaryKey(item) {
  const tokens = buildComparableSummaryTokens(item);
  return tokens.slice(0, 8).sort().join("-");
}

function normalizeComparableSummaryText(item) {
  const detail = extractSafeEventHighlight(item) || cleanEventSummary(item?.rawSummary || item?.summary || item?.shortSummary || "");
  if (!detail) return "";

  return normalizeFingerprintTextSafe(detail)
    .replace(/\b(дата и место|дата|место|когда|где|по формату|подойдет|полные условия посещения и билеты лучше проверить по ссылке в источнике)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMeaningfulComparableSummary(item) {
  return buildComparableSummaryTokens(item).length >= 2;
}

function haveMatchingComparableSummaries(left, right) {
  const leftTokens = buildComparableSummaryTokens(left);
  const rightTokens = buildComparableSummaryTokens(right);
  if (!leftTokens.length || !rightTokens.length) return false;

  const overlap = countTokenOverlap(leftTokens, rightTokens);
  const shortest = Math.max(1, Math.min(leftTokens.length, rightTokens.length));
  return overlap >= Math.min(4, shortest) || overlap / shortest >= 0.75;
}

function formatTimeKey(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function extractQuotedTokens(value) {
  const matches = [...String(value || "").matchAll(/[«"]([^»"]{2,80})[»"]/g)];
  return matches.flatMap((match) => tokenizeFingerprintSafe(match[1]));
}

function countTokenOverlap(left, right) {
  const rightSet = new Set(right);
  return left.reduce((count, token) => count + (rightSet.has(token) ? 1 : 0), 0);
}

function chooseEventDate(current, candidate) {
  if (!current?.eventDate) return candidate?.eventDate || null;
  if (!candidate?.eventDate) return current.eventDate;
  if (candidate.eventHasExplicitTime && !current.eventHasExplicitTime) return candidate.eventDate;
  if (!candidate.eventHasExplicitTime && current.eventHasExplicitTime) return current.eventDate;
  return new Date(candidate.eventDate) < new Date(current.eventDate) ? candidate.eventDate : current.eventDate;
}

function compareEventPriority(a, b) {
  const sourceDiff = (b.sourceCount || 1) - (a.sourceCount || 1);
  if (sourceDiff) return sourceDiff;

  const dateDiff = compareDates(a.eventDate, b.eventDate);
  if (dateDiff) return dateDiff;

  const priorityDiff = (b.priorityScore || b.score || 0) - (a.priorityScore || a.score || 0);
  if (priorityDiff) return priorityDiff;

  return String(a.title || "").localeCompare(String(b.title || ""), "ru");
}

function compareDates(a, b) {
  const left = a ? new Date(a).getTime() : Number.POSITIVE_INFINITY;
  const right = b ? new Date(b).getTime() : Number.POSITIVE_INFINITY;
  return left - right;
}

function buildCompactSummary(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";

  const sentences = normalized
    .replace(/\n+/g, " ")
    .match(/[^.!?]+[.!?]?/g)
    ?.map((part) => part.trim())
    .filter(Boolean) || [];

  const candidate = sentences.slice(0, 2).join(" ").trim() || normalized;
  return trim(candidate, 180);
}

function titleQuality(value) {
  const normalized = normalizeText(value);
  if (!normalized) return 0;
  let score = normalized.length;
  if (/\d/.test(normalized)) score += 20;
  if (/[«»"]/u.test(normalized)) score += 8;
  if (/^(?:\u0433\u0440\u0443\u043f\u043f\u044b|\u043f\u0435\u0432\u0446\u0430|\u0430\u0440\u0442\u0438\u0441\u0442\u0430|\u043a\u043e\u043c\u0430\u043d\u0434\u044b|\u043e\u0440\u043a\u0435\u0441\u0442\u0440\u0430)\s+/iu.test(normalized)) score -= 18;
  return score;
}

function summaryQuality(value) {
  const normalized = normalizeText(value);
  if (!normalized) return 0;
  return Math.min(normalized.length, 260) + (/[.!?]/.test(normalized) ? 15 : 0) + (/\d/.test(normalized) ? 10 : 0);
}

function textQuality(value) {
  const normalized = normalizeText(value);
  if (!normalized) return 0;
  return normalized.length + (/[«»"]/u.test(normalized) ? 6 : 0);
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function getStartOfCurrentMoscowDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  return new Date(Date.UTC(year, month - 1, day, -3, 0, 0));
}

function getEndOfMoscowDay(value) {
  const start = value instanceof Date ? value : new Date(value);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function getEndOfCurrentMoscowYear(value) {
  const base = value instanceof Date ? value : new Date(value);
  const year = Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric"
  }).format(base));
  return new Date(Date.UTC(year + 1, 0, 1, -3, 0, 0) - 1);
}

function addMoscowMonths(value, months) {
  const base = value instanceof Date ? value : new Date(value);
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric" }).format(base));
  const month = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", month: "2-digit" }).format(base));
  const day = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", day: "2-digit" }).format(base));
  return new Date(Date.UTC(year, month - 1 + months, day, -3, 0, 0));
}

function parseDateInput(value, endOfDay = false) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (endOfDay) {
    return new Date(Date.UTC(year, month - 1, day + 1, -3, 0, 0) - 1);
  }

  return new Date(Date.UTC(year, month - 1, day, -3, 0, 0));
}

function formatDateInput(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function maxDate(...dates) {
  const valid = dates.filter(Boolean);
  return valid.reduce((latest, current) => current > latest ? current : latest);
}

function minDate(...dates) {
  const valid = dates.filter(Boolean);
  return valid.reduce((earliest, current) => current < earliest ? current : earliest);
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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trim(value, maxLength) {
  const normalized = normalizeText(value);
  if (!maxLength || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function ensureSentence(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  return /[.!?…]$/u.test(normalized) ? normalized : `${normalized}.`;
}

function cryptoRandomId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function isCaptchaPage(html) {
  const text = String(html || "");
  return /showcaptcha/i.test(text) || /Вы не робот\?/i.test(text);
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

function formatMoscowDayMonth(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long"
  }).format(value);
}

function formatMoscowTime(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function formatChannelDateLabel(value, hasExplicitTime = false) {
  const dateLabel = formatMoscowDayMonth(value);
  if (!hasExplicitTime) return dateLabel;
  return `${dateLabel}, ${formatMoscowTime(value)}`;
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
  return String(value || "")
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

async function proxyExternalImage(rawUrl, env) {
  const targetUrl = parseExternalImageUrl(rawUrl);
  const upstream = await fetch(targetUrl.toString(), {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 60 * 60 * 24
    }
  });

  if (!upstream.ok) {
    throw new HttpError(`Image upstream returned HTTP ${upstream.status}.`, 502);
  }

  const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new HttpError("Upstream resource is not an image.", 415);
  }

  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") || "image/jpeg",
    "cache-control": "public, max-age=86400, s-maxage=86400",
    "access-control-allow-origin": safeOrigin(env?.MINI_APP_URL) || "*"
  });

  const contentLength = upstream.headers.get("content-length");
  const lastModified = upstream.headers.get("last-modified");
  const etag = upstream.headers.get("etag");

  if (contentLength) headers.set("content-length", contentLength);
  if (lastModified) headers.set("last-modified", lastModified);
  if (etag) headers.set("etag", etag);

  return new Response(upstream.body, {
    status: 200,
    headers
  });
}

function parseExternalImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new HttpError("Image URL is required.", 400);
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new HttpError("Image URL is invalid.", 400);
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new HttpError("Only HTTP(S) image URLs are allowed.", 400);
  }

  if (isBlockedProxyHostname(target.hostname)) {
    throw new HttpError("This image host is blocked.", 403);
  }

  return target;
}

function isBlockedProxyHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".local")) return true;
  if (normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]") return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(normalized)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(normalized)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(normalized)) return true;
  return false;
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

export const IMPORT_INTERNALS = {
  PERSISTED_EVENT_TYPES,
  mapImportedSourceType,
  mapImportedSourceName,
  normalizeExternalImportMode,
  prepareImportedEventItem,
  shouldRejectEventItem,
  itemId,
  mergeImportedEventItems,
  pruneImportedItemsToAllowedWindow,
  inferImportedMetaSourcesFromItems,
  normalizeImportedMetaSources,
  mergeImportedMetaSources,
  isAllowedEventItem
};
