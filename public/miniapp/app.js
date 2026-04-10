const tg = window.Telegram?.WebApp;
const config = window.KAZAN_EVENT_RADAR_CONFIG || {};
const apiBaseUrl = (config.apiBaseUrl || "").replace(/\/$/, "");
const params = new URLSearchParams(window.location.search);

if (tg) {
  tg.ready();
  tg.expand();
}

const state = {
  activeTab: params.get("tab") || "events",
  placeSection: params.get("section") || "parks",
  routeLevel: params.get("level") || "easy",
  selectedPlaceId: params.get("place") || null,
  selectedRouteId: params.get("route") || null,
  selectedEventId: params.get("event") || null,
  dateFrom: params.get("dateFrom") || "",
  dateTo: params.get("dateTo") || "",
  catalog: null,
  sections: [],
  events: [],
  favorites: [],
  config: null,
  periodLabel: "",
  syncedAt: null,
  totalEvents: 0,
  allowedFrom: "",
  allowedTo: "",
  defaultFrom: "",
  appliedFrom: "",
  appliedTo: ""
};

const statusNode = document.querySelector("#status");
const contentNode = document.querySelector("#content");
const tabNodes = [...document.querySelectorAll(".tab")];

bootstrap();

async function bootstrap() {
  bindEvents();

  try {
    const [runtimeConfig, catalog, events] = await Promise.all([
      api("/api/config").catch(() => ({ user: null })),
      api("/api/catalog"),
      api(buildEventsPath())
    ]);

    state.config = runtimeConfig;
    state.catalog = catalog.catalog;
    state.sections = catalog.sections;
    applyEventsPayload(events);
    state.favorites = await loadFavorites();

    if (!state.selectedPlaceId) state.selectedPlaceId = getActivePlaceItems()[0]?.id || null;
    if (!state.selectedRouteId) state.selectedRouteId = getActiveRouteItems()[0]?.id || null;

    setStatus("");
    track("page_view", "miniapp_home");
    render();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function bindEvents() {
  tabNodes.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.tab;
      track("tab_click", state.activeTab);
      syncUrl();
      render();
    });
  });

  contentNode.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;

    if (action === "place-section") {
      state.placeSection = button.dataset.section;
      state.selectedPlaceId = getActivePlaceItems()[0]?.id || null;
      track("place_section_click", state.placeSection);
      syncUrl();
      render();
      return;
    }

    if (action === "place-item") {
      state.selectedPlaceId = button.dataset.id;
      track("place_item_click", state.selectedPlaceId, { section: state.placeSection });
      syncUrl();
      render();
      return;
    }

    if (action === "route-level") {
      state.routeLevel = button.dataset.level;
      state.selectedRouteId = getActiveRouteItems()[0]?.id || null;
      track("route_level_click", state.routeLevel);
      syncUrl();
      render();
      return;
    }

    if (action === "route-item") {
      state.selectedRouteId = button.dataset.id;
      track("route_item_click", state.selectedRouteId, { level: state.routeLevel });
      syncUrl();
      render();
      return;
    }

    if (action === "event-item") {
      state.selectedEventId = button.dataset.id;
      track("event_item_click", state.selectedEventId);
      syncUrl();
      render();
      return;
    }

    if (action === "event-range-preset") {
      const range = getPresetRange(button.dataset.range);
      state.dateFrom = range.from;
      state.dateTo = range.to;
      state.selectedEventId = null;
      track("event_range_preset", button.dataset.range);
      await refreshEvents();
      return;
    }

    if (action === "event-range-apply") {
      state.dateFrom = contentNode.querySelector('[name="dateFrom"]')?.value || "";
      state.dateTo = contentNode.querySelector('[name="dateTo"]')?.value || "";
      state.selectedEventId = null;
      track("event_range_apply", `${state.dateFrom || "auto"}:${state.dateTo || "auto"}`);
      await refreshEvents();
      return;
    }

    if (action === "event-range-clear") {
      state.dateFrom = "";
      state.dateTo = "";
      state.selectedEventId = null;
      track("event_range_clear", "default");
      await refreshEvents();
      return;
    }

    if (action === "open") {
      track("outbound_link", button.dataset.url, { label: button.textContent.trim() });
      openLink(button.dataset.url);
      return;
    }

    if (action === "favorite-event") {
      await toggleFavorite(eventFavoritePayload(findEvent(button.dataset.id)));
      return;
    }

    if (action === "favorite-catalog") {
      await toggleFavorite(catalogFavoritePayload(button.dataset.section, button.dataset.id));
      return;
    }

    if (action === "favorite-route") {
      await toggleFavorite(routeFavoritePayload(button.dataset.id));
      return;
    }

    if (action === "remind") {
      await createReminder(button.dataset.id);
      return;
    }

    if (action === "favorite-open") {
      openFavorite(button.dataset.id);
    }
  });
}

async function refreshEvents() {
  try {
    setStatus("Обновляю афишу...");
    const previousId = state.selectedEventId;
    const payload = await api(buildEventsPath());
    applyEventsPayload(payload, previousId);
    setStatus("");
    render();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function applyEventsPayload(events, previousSelectedId = null) {
  state.events = events.items || [];
  state.periodLabel = events.periodLabel || "Апрель 2026";
  state.syncedAt = events.syncedAt || null;
  state.totalEvents = events.totalItems || state.events.length;
  state.allowedFrom = events.filters?.allowedFrom || "";
  state.allowedTo = events.filters?.allowedTo || "";
  state.defaultFrom = events.filters?.defaultFrom || "";
  state.appliedFrom = events.filters?.appliedFrom || state.defaultFrom || "";
  state.appliedTo = events.filters?.appliedTo || state.allowedTo || "";

  if (previousSelectedId && state.events.some((item) => item.id === previousSelectedId)) {
    state.selectedEventId = previousSelectedId;
    return;
  }

  state.selectedEventId = state.events[0]?.id || null;
}

function buildEventsPath() {
  const search = new URLSearchParams({ period: "april" });
  if (state.dateFrom) search.set("dateFrom", state.dateFrom);
  if (state.dateTo) search.set("dateTo", state.dateTo);
  return `/api/events?${search.toString()}`;
}

async function loadFavorites() {
  try {
    const response = await api("/api/favorites");
    return response.favorites || [];
  } catch {
    return [];
  }
}

function render() {
  tabNodes.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab));
  syncUrl();

  if (state.activeTab === "events") renderEvents();
  if (state.activeTab === "places") renderPlaces();
  if (state.activeTab === "routes") renderRoutes();
  if (state.activeTab === "favorites") renderFavorites();
}

function renderEvents() {
  const selected = findEvent(state.selectedEventId) || state.events[0] || null;

  contentNode.innerHTML = [
    sectionHeader(
      "Актуальная афиша",
      "Только будущие события. Коротко, по делу и с быстрым переходом к источнику и билетам."
    ),
    eventFilterPanel(),
    statBar([
      `Период: ${state.periodLabel}`,
      state.events.length ? `Показано: ${state.events.length}` : "По фильтру пока пусто",
      `Уникальных событий: ${state.totalEvents}`,
      state.syncedAt ? `Обновлено: ${formatDate(state.syncedAt)}` : "Обновление скоро"
    ]),
    selected ? eventDetailCard(selected) : empty("Пока не нашли событий под выбранный период."),
    state.events.length
      ? `<div class="list-grid">${state.events.map(eventPreviewCard).join("")}</div>`
      : empty("Ничего не нашлось в выбранном диапазоне. Попробуйте расширить даты.")
  ].join("");
}

function renderPlaces() {
  const section = state.catalog[state.placeSection];
  const items = getActivePlaceItems();
  const selected = items.find((item) => item.id === state.selectedPlaceId) || items[0] || null;

  contentNode.innerHTML = [
    `<div class="chips">${["parks", "sights", "food", "hotels", "excursions"].map((id) => chip(sectionLabel(id), "place-section", { section: id }, state.placeSection === id)).join("")}</div>`,
    sectionHeader(section.title, section.intro),
    `<div class="chip-grid">${items.map((item) => chip(item.title, "place-item", { id: item.id }, item.id === selected?.id, "wide")).join("")}</div>`,
    selected ? placeDetailCard(state.placeSection, selected) : empty("Выберите место, чтобы открыть подробную карточку.")
  ].join("");
}

function renderRoutes() {
  const routes = state.catalog.routes;
  const items = getActiveRouteItems();
  const selected = items.find((route) => route.id === state.selectedRouteId) || items[0] || null;

  contentNode.innerHTML = [
    `<div class="chips">${routes.levels.map((level) => chip(level.title, "route-level", { level: level.id }, state.routeLevel === level.id)).join("")}</div>`,
    sectionHeader("Пешие маршруты", routes.levels.find((level) => level.id === state.routeLevel)?.description || routes.intro),
    `<div class="chip-grid">${items.map((route) => chip(route.title, "route-item", { id: route.id }, route.id === selected?.id, "wide")).join("")}</div>`,
    selected ? routeDetailCard(selected) : empty("Выберите маршрут, чтобы увидеть детали и карту.")
  ].join("");
}

function renderFavorites() {
  contentNode.innerHTML = [
    sectionHeader("Избранное и личный план", "Сохраняйте события, парки, маршруты и места, чтобы быстро вернуться к ним позже."),
    state.favorites.length
      ? `<div class="grid">${state.favorites.map(favoriteCard).join("")}</div>`
      : empty("Пока пусто. Добавьте в избранное хотя бы одно событие или место.")
  ].join("");
}

function eventDetailCard(item) {
  const sourceBadge = item.sourceCount > 1 ? badge(`В ${sourceCountLabel(item.sourceCount)}`) : badge("1 источник");
  const sourceButtons = (item.sources || [])
    .filter((source) => source?.url)
    .slice(0, 2)
    .map((source) => actionButton(source.name || "Источник", "open", { url: source.url }));

  return card([
    `<h2>${escapeHtml(item.title || "Событие")}</h2>`,
    `<div class="meta-badges">
      ${badge(formatDate(item.eventDate || item.publishedAt))}
      ${sourceBadge}
      ${item.sourceName ? badge(item.sourceName) : ""}
    </div>`,
    item.shortSummary ? `<p class="card-copy">${escapeHtml(trim(item.shortSummary, 180))}</p>` : "",
    `<div class="inline-note">${escapeHtml(eventPriorityLine(item))}</div>`,
    actions([
      actionButton(favoriteToggleLabel(item.id), "favorite-event", { id: item.id }, isFavorite(item.id) ? "primary" : ""),
      `<button class="button ${item.eventDate ? "" : "ghost"}" data-action="remind" data-id="${escapeHtml(item.id)}" ${item.eventDate ? "" : "disabled"}>Напомнить</button>`,
      item.url ? actionButton("Источник", "open", { url: item.url }, "primary") : "",
      ...sourceButtons,
      ...(item.ticketLinks || []).slice(0, 4).map((link) => actionButton(link.name, "open", { url: link.url }))
    ])
  ], "active");
}

function eventPreviewCard(item) {
  return card([
    `<h3>${escapeHtml(item.title || "Событие")}</h3>`,
    `<div class="meta">${escapeHtml(formatDate(item.eventDate || item.publishedAt))}${item.sourceCount > 1 ? ` · ${escapeHtml(`в ${sourceCountLabel(item.sourceCount)}`)}` : ""}</div>`,
    item.shortSummary ? `<p>${escapeHtml(trim(item.shortSummary, 110))}</p>` : "",
    actions([
      actionButton("Открыть", "event-item", { id: item.id }, item.id === state.selectedEventId ? "primary" : ""),
      actionButton(favoriteToggleLabel(item.id), "favorite-event", { id: item.id }, isFavorite(item.id) ? "primary" : "")
    ])
  ], item.id === state.selectedEventId ? "active" : "");
}

function placeDetailCard(sectionId, item) {
  return card([
    `<h2>${escapeHtml(item.title)}</h2>`,
    item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : "",
    `<p class="card-copy">${escapeHtml(item.description)}</p>`,
    `<div class="fact-grid">
      ${item.highlights?.length ? factListBlock("Что посмотреть", item.highlights) : ""}
      ${item.reviewSummary ? factBlock("По отзывам", item.reviewSummary) : ""}
      ${item.reviewRating ? factBlock("Рейтинг", `${item.reviewRating} / 5 · ${item.reviewCount || "без числа отзывов"}`) : ""}
      ${item.foodNearby ? factBlock("Где перекусить", item.foodNearby) : ""}
      ${item.howToGet ? factBlock("Как добраться", item.howToGet) : ""}
      ${item.photoLinks?.length ? factButtonsBlock("Фотографии по сезонам", item.photoLinks) : ""}
    </div>`,
    actions([
      actionButton(favoriteToggleLabel(catalogFavoriteId(sectionId, item.id)), "favorite-catalog", { section: sectionId, id: item.id }, isFavorite(catalogFavoriteId(sectionId, item.id)) ? "primary" : ""),
      item.mapUrl ? actionButton("Маршрут на карте", "open", { url: item.mapUrl }, "primary") : "",
      item.reviewUrl ? actionButton(item.reviewSource ? `Отзывы: ${item.reviewSource}` : "Отзывы", "open", { url: item.reviewUrl }) : "",
      item.sourceUrl ? actionButton("Источник", "open", { url: item.sourceUrl }) : ""
    ])
  ], "active");
}

function routeDetailCard(route) {
  return card([
    `<h2>${escapeHtml(route.title)}</h2>`,
    `<div class="meta-badges">${route.subtitle ? badge(route.subtitle) : ""}${route.duration ? badge(route.duration) : ""}${badge(routeLevelLabel(route.level))}</div>`,
    `<p class="card-copy">${escapeHtml(route.description)}</p>`,
    `<div class="fact-grid">
      ${route.stops?.length ? factListBlock("Точки маршрута", route.stops) : ""}
      ${route.foodNearby ? factBlock("Где сделать остановку на еду", route.foodNearby) : ""}
      ${route.howToGet ? factBlock("Старт и логистика", route.howToGet) : ""}
      ${route.photoLinks?.length ? factButtonsBlock("Фотографии и настроение маршрута", route.photoLinks) : ""}
    </div>`,
    actions([
      actionButton(favoriteToggleLabel(routeFavoriteId(route.id)), "favorite-route", { id: route.id }, isFavorite(routeFavoriteId(route.id)) ? "primary" : ""),
      route.mapUrl ? actionButton("Открыть карту", "open", { url: route.mapUrl }, "primary") : "",
      route.sourceUrl ? actionButton("Источник", "open", { url: route.sourceUrl }) : ""
    ])
  ], "active");
}

function favoriteCard(item) {
  return card([
    `<h3>${escapeHtml(item.title)}</h3>`,
    item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : "",
    item.eventDate ? `<p>${escapeHtml(formatDate(item.eventDate))}</p>` : `<p>${escapeHtml(favoriteTypeLabel(item.type))}</p>`,
    actions([
      actionButton("Открыть карточку", "favorite-open", { id: item.id }, "primary"),
      item.mapUrl ? actionButton("Карта", "open", { url: item.mapUrl }) : "",
      item.url ? actionButton("Источник", "open", { url: item.url }) : ""
    ])
  ]);
}

async function toggleFavorite(payload) {
  if (!payload) return;

  try {
    const result = await api("/api/favorites/toggle", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.favorites = result.favorites || [];
    track("favorite_toggle", payload.id, { active: result.active });
    toast(result.active ? "Добавлено в избранное" : "Удалено из избранного");
    render();
  } catch (error) {
    toast(`Не удалось обновить избранное: ${error.message}`);
  }
}

async function createReminder(eventId) {
  try {
    const result = await api(`/api/reminders/events/${encodeURIComponent(eventId)}`, { method: "POST" });
    const count = result.created?.length || 0;
    track("reminder_create", eventId, { count });
    toast(count ? `Создано напоминаний: ${count}` : (result.skippedReason || "Напоминания уже есть или время события прошло"));
  } catch (error) {
    toast(`Не удалось создать напоминание: ${error.message}`);
  }
}

function openFavorite(favoriteId) {
  const favorite = state.favorites.find((item) => item.id === favoriteId);
  if (!favorite) return;

  if (favorite.type === "event") {
    state.activeTab = "events";
    state.selectedEventId = favorite.id;
  }

  if (favorite.type === "catalog") {
    state.activeTab = "places";
    state.placeSection = favorite.sectionId || state.placeSection;
    state.selectedPlaceId = favorite.itemId;
  }

  if (favorite.type === "route") {
    state.activeTab = "routes";
    state.selectedRouteId = favorite.itemId;
    const route = state.catalog?.routes?.items?.find((item) => item.id === favorite.itemId);
    if (route?.level) state.routeLevel = route.level;
  }

  track("favorite_open", favorite.id, { type: favorite.type });
  render();
}

function eventFavoritePayload(item) {
  if (!item) return null;

  return {
    type: "event",
    id: item.id,
    title: item.title || "Событие",
    subtitle: item.sourceName,
    url: item.url,
    eventDate: item.eventDate,
    sourceName: item.sourceName
  };
}

function catalogFavoritePayload(sectionId, itemId) {
  const item = state.catalog[sectionId]?.items?.find((value) => value.id === itemId);
  if (!item) return null;

  return {
    type: "catalog",
    id: catalogFavoriteId(sectionId, item.id),
    sectionId,
    itemId: item.id,
    title: item.title,
    subtitle: item.subtitle,
    url: item.sourceUrl,
    mapUrl: item.mapUrl
  };
}

function routeFavoritePayload(routeId) {
  const route = state.catalog.routes.items.find((item) => item.id === routeId);
  if (!route) return null;

  return {
    type: "route",
    id: routeFavoriteId(route.id),
    itemId: route.id,
    title: route.title,
    subtitle: route.subtitle,
    url: route.sourceUrl,
    mapUrl: route.mapUrl
  };
}

function getActivePlaceItems() {
  return state.catalog?.[state.placeSection]?.items || [];
}

function getActiveRouteItems() {
  return state.catalog?.routes?.items?.filter((route) => route.level === state.routeLevel) || [];
}

function findEvent(eventId) {
  return state.events.find((item) => item.id === eventId);
}

function isFavorite(favoriteId) {
  return state.favorites.some((item) => item.id === favoriteId);
}

function favoriteToggleLabel(favoriteId) {
  return isFavorite(favoriteId) ? "В плане" : "В план";
}

function catalogFavoriteId(sectionId, itemId) {
  return `${sectionId}:${itemId}`;
}

function routeFavoriteId(routeId) {
  return `route:${routeId}`;
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (tg?.initData) {
    headers.authorization = `tma ${tg.initData}`;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return response.json();
}

function syncUrl() {
  const next = new URLSearchParams();
  next.set("tab", state.activeTab);

  if (state.activeTab === "places") {
    next.set("section", state.placeSection);
    if (state.selectedPlaceId) next.set("place", state.selectedPlaceId);
  }

  if (state.activeTab === "routes") {
    next.set("level", state.routeLevel);
    if (state.selectedRouteId) next.set("route", state.selectedRouteId);
  }

  if (state.activeTab === "events" && state.selectedEventId) {
    next.set("event", state.selectedEventId);
  }

  if (state.dateFrom) next.set("dateFrom", state.dateFrom);
  if (state.dateTo) next.set("dateTo", state.dateTo);

  const suffix = next.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${suffix ? `?${suffix}` : ""}`);
}

function sectionHeader(title, description) {
  return `<article class="card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description || "")}</p></article>`;
}

function statBar(items) {
  return `<div class="stat-row">${items.filter(Boolean).map((item) => `<span class="stat-pill">${escapeHtml(item)}</span>`).join("")}</div>`;
}

function eventFilterPanel() {
  const presets = [
    { id: "today", label: "Сегодня" },
    { id: "3days", label: "3 дня" },
    { id: "week", label: "Неделя" },
    { id: "month", label: "Весь период" }
  ];

  return `
    <article class="card filter-panel">
      <div class="chips">${presets.map((preset) => chip(preset.label, "event-range-preset", { range: preset.id }, isPresetActive(preset.id))).join("")}</div>
      <div class="date-filter-row">
        <label class="date-field">
          <span>С</span>
          <input type="date" name="dateFrom" value="${escapeHtml(getEffectiveDateFrom())}" min="${escapeHtml(state.allowedFrom || "")}" max="${escapeHtml(state.allowedTo || "")}">
        </label>
        <label class="date-field">
          <span>По</span>
          <input type="date" name="dateTo" value="${escapeHtml(getEffectiveDateTo())}" min="${escapeHtml(state.allowedFrom || "")}" max="${escapeHtml(state.allowedTo || "")}">
        </label>
        ${actionButton("Показать", "event-range-apply", {}, "primary")}
        ${actionButton("Сбросить", "event-range-clear")}
      </div>
    </article>
  `;
}

function card(parts, extraClass = "") {
  return `<article class="card ${extraClass}">${parts.filter(Boolean).join("")}</article>`;
}

function actions(parts) {
  return `<div class="actions">${parts.filter(Boolean).join("")}</div>`;
}

function chip(label, action, data, active, extraClass = "") {
  const attrs = Object.entries(data).map(([key, value]) => `data-${key}="${escapeHtml(value)}"`).join(" ");
  return `<button class="chip ${active ? "is-active" : ""} ${extraClass}" data-action="${action}" ${attrs}>${escapeHtml(label)}</button>`;
}

function actionButton(label, action, data = {}, variant = "") {
  const attrs = Object.entries(data).map(([key, value]) => `data-${key}="${escapeHtml(value)}"`).join(" ");
  return `<button class="button ${variant}" data-action="${action}" ${attrs}>${escapeHtml(label)}</button>`;
}

function factBlock(title, text) {
  return `<section class="fact"><p class="subtle-title">${escapeHtml(title)}</p><p>${escapeHtml(text || "Пока без деталей.")}</p></section>`;
}

function factListBlock(title, items) {
  return `<section class="fact"><p class="subtle-title">${escapeHtml(title)}</p><ul class="list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;
}

function factButtonsBlock(title, links) {
  return `<section class="fact"><p class="subtle-title">${escapeHtml(title)}</p><div class="actions">${links.map((link) => actionButton(link.label, "open", { url: link.url })).join("")}</div></section>`;
}

function badge(value) {
  return `<span class="meta-badge">${escapeHtml(value)}</span>`;
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function eventPriorityLine(item) {
  if ((item.sourceCount || 1) > 1) {
    return `Событие подтвердилось в ${sourceCountLabel(item.sourceCount)} — поэтому оно выше в подборке.`;
  }

  return "Карточка короткая: за подробностями оставили прямой источник ниже.";
}

function sectionLabel(sectionId) {
  return {
    parks: "Парки",
    sights: "Достопримечательности",
    food: "Еда",
    hotels: "Отели",
    excursions: "Экскурсии"
  }[sectionId] || sectionId;
}

function routeLevelLabel(levelId) {
  return {
    easy: "Легкий",
    medium: "Средний",
    hard: "Сложный"
  }[levelId] || levelId;
}

function favoriteTypeLabel(type) {
  return {
    event: "Событие",
    catalog: "Место",
    route: "Маршрут"
  }[type] || "Избранное";
}

function openLink(url) {
  if (!url) return;
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

function toast(message) {
  if (tg?.showPopup) {
    tg.showPopup({ message });
  } else {
    setStatus(message);
    window.setTimeout(() => setStatus(""), 3000);
  }
}

function track(action, label, metadata = {}) {
  api("/api/analytics/track", {
    method: "POST",
    body: JSON.stringify({ action, label, metadata })
  }).catch(() => {});
}

function setStatus(message, isError = false) {
  statusNode.textContent = message || "";
  statusNode.classList.toggle("is-error", isError);
}

function formatDate(value) {
  return new Date(value).toLocaleString("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function getPresetRange(rangeId) {
  const from = state.defaultFrom || state.allowedFrom || "";
  const to = state.allowedTo || "";

  if (!from || !to) {
    return { from: state.dateFrom || "", to: state.dateTo || "" };
  }

  if (rangeId === "today") {
    return { from, to: from };
  }

  if (rangeId === "3days") {
    return { from, to: addDays(from, 2, to) };
  }

  if (rangeId === "week") {
    return { from, to: addDays(from, 6, to) };
  }

  return { from, to };
}

function isPresetActive(rangeId) {
  const preset = getPresetRange(rangeId);
  return preset.from === getEffectiveDateFrom() && preset.to === getEffectiveDateTo();
}

function addDays(dateString, days, maxDate) {
  const date = new Date(`${dateString}T00:00:00`);
  const limit = maxDate ? new Date(`${maxDate}T00:00:00`) : null;
  date.setDate(date.getDate() + days);
  const formatted = date.toISOString().slice(0, 10);
  if (!limit) return formatted;
  return formatted > maxDate ? maxDate : formatted;
}

function getEffectiveDateFrom() {
  return state.dateFrom || state.appliedFrom || state.defaultFrom || "";
}

function getEffectiveDateTo() {
  return state.dateTo || state.appliedTo || state.allowedTo || "";
}

function sourceCountLabel(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) return `${count} источнике`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} источниках`;
  return `${count} источниках`;
}

function trim(text, maxLength) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…` : normalized;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
