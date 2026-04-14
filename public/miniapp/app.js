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
  selectedFoodId: params.get("food") || null,
  selectedActiveId: params.get("active") || null,
  selectedRoadtripId: params.get("roadtrip") || null,
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
  defaultTo: "",
  appliedFrom: "",
  appliedTo: ""
};

const statusNode = document.querySelector("#status");
const contentNode = document.querySelector("#content");
const tabNodes = [...document.querySelectorAll(".tab")];
const heroEyebrowNode = document.querySelector("#heroEyebrow");
const heroTitleNode = document.querySelector("#heroTitle");
const heroTextNode = document.querySelector("#heroText");
const heroBadgesNode = document.querySelector("#heroBadges");
const SECTION_VISUALS = {
  events: "./brand/section-events.png",
  places: "./brand/section-parks.png",
  food: "./brand/section-food.png",
  routes: "./brand/section-routes.png",
  active: "./brand/section-events.png",
  roadtrip: "./brand/section-routes.png",
  favorites: "./brand/welcome-kazan-event-radar-640x360.png",
  parks: "./brand/section-parks.png",
  sights: "./brand/section-events.png",
  hotels: "./brand/welcome-kazan-event-radar-640x360.png",
  excursions: "./brand/section-routes.png"
};

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
    if (!state.selectedFoodId) state.selectedFoodId = getSectionItems("food")[0]?.id || null;
    if (!state.selectedActiveId) state.selectedActiveId = getSectionItems("active")[0]?.id || null;
    if (!state.selectedRoadtripId) state.selectedRoadtripId = getSectionItems("roadtrip")[0]?.id || null;

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

  heroBadgesNode?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='hero-favorites']");
    if (!button) return;

    state.activeTab = "favorites";
    track("hero_favorites_open", "favorites");
    syncUrl();
    render();
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

    if (action === "section-item") {
      const section = button.dataset.section;
      const itemId = button.dataset.id;

      if (section === "food") state.selectedFoodId = itemId;
      if (section === "active") state.selectedActiveId = itemId;
      if (section === "roadtrip") state.selectedRoadtripId = itemId;

      track("section_item_click", itemId, { section });
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
      return;
    }

    if (action === "favorite-remove") {
      await removeFavorite(button.dataset.id);
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
  state.defaultTo = events.filters?.defaultTo || state.allowedTo || "";
  state.appliedFrom = events.filters?.appliedFrom || state.defaultFrom || "";
  state.appliedTo = events.filters?.appliedTo || state.defaultTo || state.allowedTo || "";

  if (previousSelectedId && state.events.some((item) => item.id === previousSelectedId)) {
    state.selectedEventId = previousSelectedId;
    return;
  }

  state.selectedEventId = state.events[0]?.id || null;
}

function buildEventsPath() {
  const search = new URLSearchParams();
  if (state.dateFrom) search.set("dateFrom", state.dateFrom);
  if (state.dateTo) search.set("dateTo", state.dateTo);
  const suffix = search.toString();
  return `/api/events${suffix ? `?${suffix}` : ""}`;
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
  renderHero();
  syncUrl();

  if (state.activeTab === "events") renderEvents();
  if (state.activeTab === "places") renderPlaces();
  if (state.activeTab === "food") renderFood();
  if (state.activeTab === "routes") renderRoutes();
  if (state.activeTab === "active") renderActive();
  if (state.activeTab === "roadtrip") renderRoadtrip();
  if (state.activeTab === "favorites") renderFavorites();
}

function renderHero() {
  if (!heroTitleNode || !heroTextNode || !heroEyebrowNode || !heroBadgesNode) return;

  const content = {
    events: {
      eyebrow: "Kazan Event Radar",
      title: "Казань без лишнего поиска",
      text: "Только будущие события из Яндекс Афиши и MTS Live. Короткие карточки, фильтр по датам и быстрый переход к источнику без лишнего шума.",
      badges: [
        state.periodLabel || "Будущие события",
        state.events.length ? `${state.events.length} карточек` : "Афиша обновляется"
      ]
    },
    places: {
      eyebrow: "Места города",
      title: "Культовые точки, парки и видовые места",
      text: "Быстрый гид по городу: что посмотреть, где пройтись и как удобнее добраться.",
      badges: [sectionLabel(state.placeSection), `${getActivePlaceItems().length || 0} мест`]
    },
    food: {
      eyebrow: "Еда",
      title: "Рестораны с понятным описанием",
      text: "Кухня, блюда, атмосфера, отзывы и логистика без туристической перегрузки.",
      badges: ["Кухня и интерьер", `${getSectionItems("food").length || 0} мест`]
    },
    routes: {
      eyebrow: "Пешие маршруты",
      title: "Гулять по Казани по длине и темпу",
      text: "Легкие, средние и длинные прогулки с понятным стартом, остановками и финишем.",
      badges: [routeLevelLabel(state.routeLevel), `${getActiveRouteItems().length || 0} маршрутов`]
    },
    active: {
      eyebrow: "Активный отдых",
      title: "Когда хочется не только гулять",
      text: "Собрала варианты для активного дня: акваформат, развлечения и места для компании.",
      badges: ["Для семьи и друзей", `${getSectionItems("active").length || 0} идей`]
    },
    roadtrip: {
      eyebrow: "На машине",
      title: "Точки, куда удобнее ехать с авто",
      text: "Эти направления быстрее и комфортнее посещать на машине, но часть из них доступна и автобусом или экскурсией.",
      badges: ["За пределами центра", `${getSectionItems("roadtrip").length || 0} направлений`]
    },
    favorites: {
      eyebrow: "Мой план",
      title: "Сохраненные события и места",
      text: "Здесь можно быстро открыть сохраненную карточку или убрать ее из избранного.",
      badges: [state.favorites.length ? `${state.favorites.length} в плане` : "План пока пуст"]
    }
  }[state.activeTab] || {
    eyebrow: "Kazan Event Radar",
    title: "Казань без лишнего поиска",
    text: "Афиша, места и готовые сценарии для города.",
    badges: []
  };

  heroEyebrowNode.textContent = content.eyebrow;
  heroTitleNode.textContent = content.title;
  heroTextNode.textContent = content.text;
  heroBadgesNode.innerHTML = [
    ...content.badges.map((item) => `<span class="hero-badge">${escapeHtml(item)}</span>`),
    `<button class="hero-badge hero-badge-button" data-action="hero-favorites">Мой план${state.favorites.length ? ` · ${state.favorites.length}` : ""}</button>`
  ].join("");
}

function renderEvents() {
  const selected = findEvent(state.selectedEventId) || state.events[0] || null;

  contentNode.innerHTML = [
    sectionHeader(
      "Актуальная афиша",
      "Только будущие события. Коротко, по делу и с быстрым переходом к источнику и билетам.",
      SECTION_VISUALS.events
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
    `<div class="chips">${["parks", "sights", "hotels", "excursions"].map((id) => chip(sectionLabel(id), "place-section", { section: id }, state.placeSection === id)).join("")}</div>`,
    sectionHeader(section.title, section.intro, SECTION_VISUALS[state.placeSection] || SECTION_VISUALS.places),
    `<div class="chip-grid">${items.map((item) => chip(item.title, "place-item", { id: item.id }, item.id === selected?.id, "wide")).join("")}</div>`,
    selected ? placeDetailCard(state.placeSection, selected) : empty("Выберите место, чтобы открыть подробную карточку.")
  ].join("");
}

function renderFood() {
  const section = state.catalog.food;
  const items = getSectionItems("food");
  const selected = items.find((item) => item.id === state.selectedFoodId) || items[0] || null;

  contentNode.innerHTML = [
    sectionHeader(section.title, section.intro, SECTION_VISUALS.food),
    `<div class="chip-grid">${items.map((item) => chip(item.title, "section-item", { section: "food", id: item.id }, item.id === selected?.id, "wide")).join("")}</div>`,
    selected ? foodDetailCard(selected) : empty("Выберите место, чтобы открыть карточку ресторана.")
  ].join("");
}

function renderActive() {
  renderSectionExplorer("active", "Выберите место для активного отдыха.");
}

function renderRoadtrip() {
  renderSectionExplorer("roadtrip", "Выберите направление для поездки.");
}

function renderSectionExplorer(sectionId, emptyText) {
  const section = state.catalog[sectionId];
  const items = getSectionItems(sectionId);
  const selectedId = getSelectedSectionId(sectionId);
  const selected = items.find((item) => item.id === selectedId) || items[0] || null;

  contentNode.innerHTML = [
    sectionHeader(section.title, section.intro, SECTION_VISUALS[sectionId]),
    `<div class="chip-grid">${items.map((item) => chip(item.title, "section-item", { section: sectionId, id: item.id }, item.id === selected?.id, "wide")).join("")}</div>`,
    selected ? placeDetailCard(sectionId, selected) : empty(emptyText)
  ].join("");
}

function renderRoutes() {
  const routes = state.catalog.routes;
  const items = getActiveRouteItems();
  const selected = items.find((route) => route.id === state.selectedRouteId) || items[0] || null;

  contentNode.innerHTML = [
    `<div class="chips">${routes.levels.map((level) => chip(level.title, "route-level", { level: level.id }, state.routeLevel === level.id)).join("")}</div>`,
    sectionHeader("Пешие маршруты", routes.levels.find((level) => level.id === state.routeLevel)?.description || routes.intro, SECTION_VISUALS.routes),
    `<div class="chip-grid">${items.map((route) => chip(route.title, "route-item", { id: route.id }, route.id === selected?.id, "wide")).join("")}</div>`,
    selected ? routeDetailCard(selected) : empty("Выберите маршрут, чтобы увидеть детали и карту.")
  ].join("");
}

function renderFavorites() {
  contentNode.innerHTML = [
    sectionHeader("Избранное и личный план", "Сохраняйте события, парки, маршруты и места, чтобы быстро вернуться к ним позже и при необходимости сразу убрать их из плана.", SECTION_VISUALS.favorites),
    state.favorites.length
      ? `<div class="grid">${state.favorites.map(favoriteCard).join("")}</div>`
      : empty("Пока пусто. Добавьте в избранное хотя бы одно событие или место.")
  ].join("");
}

function eventDetailCard(item) {
  const sourceButtons = (item.sources || [])
    .filter((source) => source?.url)
    .slice(0, 1)
    .map((source) => actionButton(source.name || "Источник", "open", { url: source.url }));
  const dateLabel = formatEventDateOnly(item.eventDate || item.publishedAt);
  const timeLabel = formatEventTimeOnly(item.eventDate, item.eventHasExplicitTime);
  const venueLabel = eventVenueText(item);
  const sourceLabel = item.sourceName || item.sources?.[0]?.name || "Прямой источник";

  return card([
    item.imageUrl ? mediaImage(item.imageUrl, eventCardTitle(item) || "Событие") : "",
    `<div class="preview-label">${escapeHtml(eventTypeLabel(item))}</div>`,
    `<h2 class="detail-title">${escapeHtml(eventCardTitle(item) || "Событие")}</h2>`,
    eventCardSummary(item) ? richTextBlock(splitSummaryParagraphs(eventCardSummary(item), 4)) : "",
    `<div class="fact-grid">
      ${dateLabel ? factBlock("Дата", dateLabel) : ""}
      ${timeLabel ? factBlock("Время", timeLabel) : ""}
      ${venueLabel ? factBlock("Место", venueLabel) : ""}
      ${sourceLabel ? factBlock("Источник", sourceLabel) : ""}
    </div>`,
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
  const meta = [formatEventDateOnly(item.eventDate || item.publishedAt), formatEventTimeOnly(item.eventDate, item.eventHasExplicitTime), eventVenueText(item)].filter(Boolean).join(" · ");
  return card([
    item.imageUrl ? mediaImage(item.imageUrl, eventCardTitle(item) || "Событие", "compact") : "",
    `<div class="preview-label">${escapeHtml(eventTypeLabel(item))}</div>`,
    `<h3>${escapeHtml(eventCardTitle(item) || "Событие")}</h3>`,
    meta ? `<div class="meta">${escapeHtml(meta)}</div>` : "",
    `<p class="summary-short">${escapeHtml(trim(eventCardSummary(item), 150))}</p>`,
    actions([
      actionButton("Открыть", "event-item", { id: item.id }, item.id === state.selectedEventId ? "primary" : ""),
      actionButton(favoriteToggleLabel(item.id), "favorite-event", { id: item.id }, isFavorite(item.id) ? "primary" : "")
    ])
  ], item.id === state.selectedEventId ? "active" : "");
}

function placeDetailCard(sectionId, item) {
  const fallbackImage = SECTION_VISUALS[sectionId] || SECTION_VISUALS.places;
  const highlightsTitle = sectionId === "active" ? "Что внутри" : "Что посмотреть";
  return card([
    (item.imageUrl || fallbackImage) ? mediaImage(item.imageUrl || fallbackImage, item.title) : "",
    `<h2>${escapeHtml(item.title)}</h2>`,
    item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : "",
    richTextBlock(item.description),
    `<div class="fact-grid">
      ${item.highlights?.length ? factListBlock(highlightsTitle, item.highlights) : ""}
      ${item.bestFor ? factBlock(sectionId === "roadtrip" ? "Зачем ехать" : "Кому подойдет", item.bestFor) : ""}
      ${item.timing ? factBlock("Когда лучше", item.timing) : ""}
      ${item.reviewSummary ? factBlock("По отзывам", item.reviewSummary) : ""}
      ${item.reviewRating ? factBlock("Рейтинг", `${item.reviewRating} / 5 · ${item.reviewCount || "без числа отзывов"}`) : ""}
      ${item.foodNearby ? factBlock("Где перекусить", item.foodNearby) : ""}
      ${item.howToGet ? factBlock("Как добраться", item.howToGet) : ""}
      ${item.photoLinks?.length ? factButtonsBlock("Подборка фото", item.photoLinks) : ""}
    </div>`,
    actions([
      actionButton(favoriteToggleLabel(catalogFavoriteId(sectionId, item.id)), "favorite-catalog", { section: sectionId, id: item.id }, isFavorite(catalogFavoriteId(sectionId, item.id)) ? "primary" : ""),
      item.mapUrl ? actionButton("Маршрут на карте", "open", { url: item.mapUrl }, "primary") : "",
      item.reviewUrl ? actionButton(item.reviewSource ? `Отзывы: ${item.reviewSource}` : "Отзывы", "open", { url: item.reviewUrl }) : "",
      item.sourceUrl ? actionButton("Источник", "open", { url: item.sourceUrl }) : ""
    ])
  ], "active");
}

function foodDetailCard(item) {
  return card([
    mediaImage(item.imageUrl || SECTION_VISUALS.food, item.title),
    `<h2>${escapeHtml(item.title)}</h2>`,
    item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : "",
    richTextBlock(item.description),
    `<div class="fact-grid">
      ${item.cuisine ? factBlock("Кухня", item.cuisine) : ""}
      ${item.signatureDishes?.length ? factListBlock("Ключевые блюда", item.signatureDishes) : ""}
      ${item.interior ? factBlock("Интерьер", item.interior) : ""}
      ${item.reviewSummary ? factBlock("По отзывам", item.reviewSummary) : ""}
      ${item.features?.length ? factListBlock("Главные фишки", item.features) : ""}
      ${item.howToGet ? factBlock("Как добраться", item.howToGet) : ""}
    </div>`,
    actions([
      actionButton(favoriteToggleLabel(catalogFavoriteId("food", item.id)), "favorite-catalog", { section: "food", id: item.id }, isFavorite(catalogFavoriteId("food", item.id)) ? "primary" : ""),
      item.mapUrl ? actionButton("Открыть карту", "open", { url: item.mapUrl }, "primary") : "",
      item.reviewUrl ? actionButton(item.reviewSource ? `Отзывы: ${item.reviewSource}` : "Отзывы", "open", { url: item.reviewUrl }) : "",
      item.sourceUrl ? actionButton("Источник", "open", { url: item.sourceUrl }) : ""
    ])
  ], "active");
}

function routeDetailCard(route) {
  return card([
    (route.imageUrl || SECTION_VISUALS.routes) ? mediaImage(route.imageUrl || SECTION_VISUALS.routes, route.title) : "",
    `<h2>${escapeHtml(route.title)}</h2>`,
    `<div class="meta-badges">${route.subtitle ? badge(route.subtitle) : ""}${route.duration ? badge(route.duration) : ""}${badge(routeLevelLabel(route.level))}</div>`,
    richTextBlock(route.description),
    `<div class="fact-grid">
      ${route.stops?.length ? factListBlock("Точки маршрута", route.stops) : ""}
      ${route.foodNearby ? factBlock("Где сделать остановку на еду", route.foodNearby) : ""}
      ${route.howToGet ? factBlock("Старт и логистика", route.howToGet) : ""}
      ${route.photoLinks?.length ? factButtonsBlock("Подборка фото", route.photoLinks) : ""}
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
    item.eventDate ? `<p>${escapeHtml(formatDate(item.eventDate))}</p>` : `<p>${escapeHtml(favoriteTypeLabel(item.type, item.sectionId))}</p>`,
    actions([
      actionButton("Открыть карточку", "favorite-open", { id: item.id }, "primary"),
      actionButton("Убрать", "favorite-remove", { id: item.id }),
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

async function removeFavorite(favoriteId) {
  const favorite = state.favorites.find((item) => item.id === favoriteId);
  if (!favorite) return;
  await toggleFavorite(favorite);
}

function openFavorite(favoriteId) {
  const favorite = state.favorites.find((item) => item.id === favoriteId);
  if (!favorite) return;

  if (favorite.type === "event") {
    state.activeTab = "events";
    state.selectedEventId = favorite.id;
  }

  if (favorite.type === "catalog") {
    if (favorite.sectionId === "food") {
      state.activeTab = "food";
      state.selectedFoodId = favorite.itemId;
    } else if (favorite.sectionId === "active") {
      state.activeTab = "active";
      state.selectedActiveId = favorite.itemId;
    } else if (favorite.sectionId === "roadtrip") {
      state.activeTab = "roadtrip";
      state.selectedRoadtripId = favorite.itemId;
    } else {
      state.activeTab = "places";
      state.placeSection = favorite.sectionId || state.placeSection;
      state.selectedPlaceId = favorite.itemId;
    }
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

function getSectionItems(sectionId) {
  return state.catalog?.[sectionId]?.items || [];
}

function getSelectedSectionId(sectionId) {
  if (sectionId === "food") return state.selectedFoodId;
  if (sectionId === "active") return state.selectedActiveId;
  if (sectionId === "roadtrip") return state.selectedRoadtripId;
  return null;
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
  return isFavorite(favoriteId) ? "Убрать из плана" : "В план";
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

  if (state.activeTab === "food" && state.selectedFoodId) {
    next.set("food", state.selectedFoodId);
  }

  if (state.activeTab === "active" && state.selectedActiveId) {
    next.set("active", state.selectedActiveId);
  }

  if (state.activeTab === "roadtrip" && state.selectedRoadtripId) {
    next.set("roadtrip", state.selectedRoadtripId);
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

function sectionHeader(title, description, imageUrl = "") {
  return `<article class="card section-hero">${imageUrl ? mediaImage(imageUrl, title) : ""}<h2>${escapeHtml(title)}</h2>${richTextBlock(description || "")}</article>`;
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
  return `<section class="fact"><p class="subtle-title">${escapeHtml(title)}</p><div class="photo-grid">${links.map((link) => `<a class="photo-tile" href="${escapeHtml(link.url)}" target="_blank" rel="noopener"><span>${escapeHtml(link.label)}</span></a>`).join("")}</div></section>`;
}

function badge(value) {
  return `<span class="meta-badge">${escapeHtml(value)}</span>`;
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function mediaImage(url, alt, extraClass = "") {
  return `<div class="media-frame ${extraClass}"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer"></div>`;
}

function richTextBlock(text) {
  const paragraphs = String(text || "")
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!paragraphs.length) return "";

  return `<div class="card-copy">${paragraphs.map((part) => `<p>${escapeHtml(part)}</p>`).join("")}</div>`;
}

function eventTypeLabel(item) {
  if (item.kind === "concert") return "Концерт";
  if (item.kind === "theatre") return "Спектакль";
  if (item.kind === "show") return "Шоу";
  if (item.kind === "standup") return "Стендап";
  if (item.kind === "exhibition") return "Выставка";
  if (item.kind === "excursion") return "Экскурсия";
  if (item.kind === "musical") return "Мюзикл";
  if (item.kind === "kids") return "Детям";

  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  if (text.includes("мастер-класс")) return "Мастер-класс";
  if (text.includes("спектак")) return "Спектакль";
  if (text.includes("выстав")) return "Выставка";
  if (text.includes("лекц")) return "Лекция";
  if (text.includes("экскурс")) return "Экскурсия";
  if (text.includes("стендап")) return "Стендап";
  if (text.includes("фестив")) return "Фестиваль";
  if (text.includes("шоу")) return "Шоу";
  return "Концерт";
}

function eventCardTitle(item) {
  const base = trim(firstMeaningfulLine(item.title || item.summary || "Событие"), 84)
    .replace(/^\d{1,2}[.:]\d{2}\s*/u, "")
    .replace(/^\d{1,2}\s+[а-яё]+\s*/iu, "")
    .replace(/^(концерт|спектакль|мастер-класс|выставка|лекция|экскурсия|стендап|фестиваль|шоу)\s*/iu, "")
    .trim();

  if (!base) return item.title || "Событие";
  return base;
}

function eventCardSummary(item) {
  return trim((item.shortSummary || item.summary || item.title || "").replace(/\s+/g, " "), 280);
}

function splitSummaryParagraphs(text, limit = 4) {
  return String(text || "")
    .match(/[^.!?]+[.!?]?/g)
    ?.map((part) => part.trim())
    .filter(Boolean)
    .slice(0, limit) || [];
}

function firstMeaningfulLine(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function eventVenueText(item) {
  if (item.venueTitle) return item.venueTitle;

  const text = `${item.title || ""}\n${item.summary || ""}`;
  const patterns = [
    /(?:место|площадка|адрес)\s*[:\-]\s*([^\n.;]{3,90})/iu,
    /(?:в|во|на)\s+(МВЦ\s+[«"][^»"]+[»"]|КРК\s+[«"][^»"]+[»"]|Казань Экспо|Пирамида|Уникс|Корстон|MOÑ|Ак Барс Арена|ЦСКА Арена|Театр[^.,\n;]{1,80}|клуб[^.,\n;]{1,80}|парке?\s+[^.,\n;]{1,80})/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return "";
}

function formatEventDateOnly(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long"
  });
}

function formatEventTimeOnly(value, hasExplicitTime = true) {
  if (!value || !hasExplicitTime) return "";
  return new Date(value).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function sectionLabel(sectionId) {
  return {
    parks: "Парки",
    sights: "Достопримечательности",
    food: "Еда",
    hotels: "Отели",
    excursions: "Экскурсии",
    active: "Активный отдых",
    roadtrip: "На машине"
  }[sectionId] || sectionId;
}

function routeLevelLabel(levelId) {
  return {
    easy: "Легкий",
    medium: "Средний",
    hard: "Сложный"
  }[levelId] || levelId;
}

function favoriteTypeLabel(type, sectionId = "") {
  if (type === "catalog" && sectionId) return sectionLabel(sectionId);
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
  const to = state.defaultTo || state.allowedTo || "";

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
  return state.dateTo || state.appliedTo || state.defaultTo || state.allowedTo || "";
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
