const tg = window.Telegram?.WebApp;
const config = window.KAZAN_EVENT_RADAR_CONFIG || {};
const apiBaseUrl = (config.apiBaseUrl || "").replace(/\/$/, "");

if (tg) {
  tg.ready();
  tg.expand();
}

const state = {
  activeTab: "events",
  placeSection: "parks",
  routeLevel: "easy",
  catalog: null,
  events: [],
  favorites: [],
  config: null
};

const statusNode = document.querySelector("#status");
const contentNode = document.querySelector("#content");
const tabNodes = [...document.querySelectorAll(".tab")];

bootstrap();

async function bootstrap() {
  bindEvents();

  try {
    const [config, catalog, events] = await Promise.all([
      api("/api/config").catch(() => ({ user: null })),
      api("/api/catalog"),
      api("/api/events?period=april")
    ]);

    state.config = config;
    state.catalog = catalog.catalog;
    state.sections = catalog.sections;
    state.events = events.items || [];
    state.favorites = await loadFavorites();
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
      render();
    });
  });

  contentNode.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;

    if (action === "place-section") {
      state.placeSection = button.dataset.section;
      track("place_section_click", state.placeSection);
      render();
      return;
    }

    if (action === "route-level") {
      state.routeLevel = button.dataset.level;
      track("route_level_click", state.routeLevel);
      render();
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
    }
  });
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

  if (state.activeTab === "events") renderEvents();
  if (state.activeTab === "places") renderPlaces();
  if (state.activeTab === "routes") renderRoutes();
  if (state.activeTab === "favorites") renderFavorites();
}

function renderEvents() {
  contentNode.innerHTML = [
    sectionHeader("Актуальная афиша", "Мероприятия на апрель 2026 года. Добавляйте события в избранное и ставьте напоминания за сутки и за час."),
    state.events.length
      ? `<div class="grid">${state.events.map(eventCard).join("")}</div>`
      : empty("Пока нет событий. Нажмите /scan в боте или добавьте источники.")
  ].join("");
}

function renderPlaces() {
  const sections = ["parks", "sights", "food", "hotels", "excursions"];
  const section = state.catalog[state.placeSection];

  contentNode.innerHTML = [
    `<div class="chips">${sections.map((id) => chip(sectionLabel(id), "place-section", { section: id }, state.placeSection === id)).join("")}</div>`,
    sectionHeader(section.title, section.intro),
    `<div class="grid">${section.items.map((item) => catalogCard(state.placeSection, item)).join("")}</div>`
  ].join("");
}

function renderRoutes() {
  const routes = state.catalog.routes;
  const items = routes.items.filter((route) => route.level === state.routeLevel);

  contentNode.innerHTML = [
    `<div class="chips">${routes.levels.map((level) => chip(level.title, "route-level", { level: level.id }, state.routeLevel === level.id)).join("")}</div>`,
    sectionHeader("Пешие маршруты", routes.levels.find((level) => level.id === state.routeLevel)?.description || routes.intro),
    `<div class="grid">${items.map(routeCard).join("")}</div>`
  ].join("");
}

function renderFavorites() {
  contentNode.innerHTML = [
    sectionHeader("Избранное и план", "Здесь собираются места и мероприятия, которые пользователь хочет посетить."),
    state.favorites.length
      ? `<div class="grid">${state.favorites.map(favoriteCard).join("")}</div>`
      : empty("Пока пусто. Добавьте событие, парк, ресторан, отель или маршрут.")
  ].join("");
}

function eventCard(item) {
  const date = item.eventDate ? formatDate(item.eventDate) : "дата уточняется";
  const reminderDisabled = item.eventDate ? "" : "disabled";

  return card([
    `<h3>${escapeHtml(item.title || "Событие")}</h3>`,
    `<div class="meta">${escapeHtml(date)}${item.sourceName ? ` · ${escapeHtml(item.sourceName)}` : ""}</div>`,
    item.summary ? `<p>${escapeHtml(trim(item.summary, 240))}</p>` : "",
    actions([
      actionButton("В избранное", "favorite-event", { id: item.id }),
      `<button class="button" data-action="remind" data-id="${escapeHtml(item.id)}" ${reminderDisabled}>Напомнить</button>`,
      item.url ? actionButton("Источник", "open", { url: item.url }, "primary") : "",
      ...(item.ticketLinks || []).slice(0, 4).map((link) => actionButton(link.name, "open", { url: link.url }))
    ])
  ]);
}

function catalogCard(sectionId, item) {
  return card([
    `<h3>${escapeHtml(item.title)}</h3>`,
    item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : "",
    `<p>${escapeHtml(trim(item.description, 220))}</p>`,
    item.highlights?.length ? `<ul class="list">${item.highlights.slice(0, 4).map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : "",
    actions([
      actionButton("В избранное", "favorite-catalog", { section: sectionId, id: item.id }),
      item.mapUrl ? actionButton("Маршрут", "open", { url: item.mapUrl }, "primary") : "",
      item.sourceUrl ? actionButton("Подробнее", "open", { url: item.sourceUrl }) : ""
    ])
  ]);
}

function routeCard(route) {
  return card([
    `<h3>${escapeHtml(route.title)}</h3>`,
    `<div class="meta">${escapeHtml(route.subtitle || "")} · ${escapeHtml(route.duration || "")}</div>`,
    `<p>${escapeHtml(trim(route.description, 220))}</p>`,
    `<ul class="list">${route.stops.slice(0, 6).map((stop) => `<li>${escapeHtml(stop)}</li>`).join("")}</ul>`,
    actions([
      actionButton("В избранное", "favorite-route", { id: route.id }),
      route.mapUrl ? actionButton("Маршрут", "open", { url: route.mapUrl }, "primary") : ""
    ])
  ]);
}

function favoriteCard(item) {
  return card([
    `<h3>${escapeHtml(item.title)}</h3>`,
    item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : "",
    item.eventDate ? `<p>Когда: ${escapeHtml(formatDate(item.eventDate))}</p>` : "",
    actions([
      item.mapUrl ? actionButton("Маршрут", "open", { url: item.mapUrl }, "primary") : "",
      item.url ? actionButton("Открыть", "open", { url: item.url }, "primary") : ""
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
    toast(count ? `Создано напоминаний: ${count}` : (result.skippedReason || "Напоминания уже есть или время прошло"));
  } catch (error) {
    toast(`Не удалось создать напоминание: ${error.message}`);
  }
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
    id: `${sectionId}:${item.id}`,
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
    id: `route:${route.id}`,
    itemId: route.id,
    title: route.title,
    subtitle: route.subtitle,
    url: route.sourceUrl,
    mapUrl: route.mapUrl
  };
}

function findEvent(eventId) {
  return state.events.find((item) => item.id === eventId);
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

function sectionHeader(title, description) {
  return `<article class="card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description || "")}</p></article>`;
}

function card(parts) {
  return `<article class="card">${parts.filter(Boolean).join("")}</article>`;
}

function actions(parts) {
  return `<div class="actions">${parts.filter(Boolean).join("")}</div>`;
}

function chip(label, action, data, active) {
  const attrs = Object.entries(data).map(([key, value]) => `data-${key}="${escapeHtml(value)}"`).join(" ");
  return `<button class="chip ${active ? "is-active" : ""}" data-action="${action}" ${attrs}>${escapeHtml(label)}</button>`;
}

function actionButton(label, action, data = {}, variant = "") {
  const attrs = Object.entries(data).map(([key, value]) => `data-${key}="${escapeHtml(value)}"`).join(" ");
  return `<button class="button ${variant}" data-action="${action}" ${attrs}>${escapeHtml(label)}</button>`;
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
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

function trim(text, maxLength) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
