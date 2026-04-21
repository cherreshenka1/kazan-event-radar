const tg = window.Telegram?.WebApp;
const config = window.KAZAN_EVENT_RADAR_CONFIG || {};
const apiBaseUrl = (config.apiBaseUrl || "").replace(/\/$/, "");
const params = new URLSearchParams(window.location.search);
const EVENTS_FETCH_LIMIT = 1000;

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
  openEventId: params.get("event") || null,
  selectedFoodId: params.get("food") || null,
  selectedActiveId: params.get("active") || null,
  selectedRoadtripId: params.get("roadtrip") || null,
  selectedFavoriteId: params.get("favorite") || null,
  eventCategory: params.get("category") || "all",
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
const PHOTO_MANIFEST = window.KAZAN_EVENT_RADAR_PHOTO_MANIFEST || {};
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
const eventVisualCache = new Map();

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
    if (!state.selectedFavoriteId) state.selectedFavoriteId = state.favorites[0]?.id || null;

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
      if (state.activeTab !== "events") state.openEventId = null;
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
      state.openEventId = button.dataset.id;
      track("event_item_click", state.selectedEventId);
      syncUrl();
      render();
      return;
    }

    if (action === "event-category") {
      state.eventCategory = button.dataset.category || "all";
      state.selectedEventId = null;
      state.openEventId = null;
      track("event_category", state.eventCategory);
      await refreshEvents();
      return;
    }

    if (action === "event-close") {
      state.openEventId = null;
      track("event_close", state.selectedEventId || "event");
      syncUrl();
      render();
      return;
    }

    if (action === "event-range-preset") {
      const range = getPresetRange(button.dataset.range);
      state.dateFrom = range.from;
      state.dateTo = range.to;
      state.selectedEventId = null;
      state.openEventId = null;
      track("event_range_preset", button.dataset.range);
      await refreshEvents();
      return;
    }

    if (action === "event-range-apply") {
      state.dateFrom = contentNode.querySelector('[name="dateFrom"]')?.value || "";
      state.dateTo = contentNode.querySelector('[name="dateTo"]')?.value || "";
      state.selectedEventId = null;
      state.openEventId = null;
      track("event_range_apply", `${state.dateFrom || "auto"}:${state.dateTo || "auto"}`);
      await refreshEvents();
      return;
    }

    if (action === "event-range-clear") {
      state.dateFrom = "";
      state.dateTo = "";
      state.selectedEventId = null;
      state.openEventId = null;
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

    if (action === "favorite-focus") {
      state.selectedFavoriteId = button.dataset.id;
      track("favorite_focus", state.selectedFavoriteId);
      syncUrl();
      render();
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
  state.totalEvents = events.matchingItems || events.totalItems || state.events.length;
  state.allowedFrom = events.filters?.allowedFrom || "";
  state.allowedTo = events.filters?.allowedTo || "";
  state.defaultFrom = events.filters?.defaultFrom || "";
  state.defaultTo = events.filters?.defaultTo || state.allowedTo || "";
  state.appliedFrom = events.filters?.appliedFrom || state.defaultFrom || "";
  state.appliedTo = events.filters?.appliedTo || state.defaultTo || state.allowedTo || "";

  if (previousSelectedId && state.events.some((item) => item.id === previousSelectedId)) {
    state.selectedEventId = previousSelectedId;
  } else {
    state.selectedEventId = state.events[0]?.id || null;
  }

  if (state.openEventId && !state.events.some((item) => item.id === state.openEventId)) {
    state.openEventId = null;
  }
}

function buildEventsPath() {
  const search = new URLSearchParams();
  search.set("limit", String(EVENTS_FETCH_LIMIT));
  if (state.eventCategory && state.eventCategory !== "all") search.set("category", state.eventCategory);
  if (state.dateFrom) search.set("dateFrom", state.dateFrom);
  if (state.dateTo) search.set("dateTo", state.dateTo);
  const suffix = search.toString();
  return `/api/events${suffix ? `?${suffix}` : ""}`;
}

async function loadFavorites() {
  if (!tg?.initData) return [];

  try {
    const response = await api("/api/favorites");
    return response.favorites || [];
  } catch {
    return [];
  }
}

function render() {
  tabNodes.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab));
  document.body.classList.toggle("modal-open", state.activeTab === "events" && Boolean(state.openEventId));
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
      text: "Будущие события, короткие карточки, удобный фильтр по датам и быстрый переход к полной информации без лишнего шума.",
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
  const opened = findEvent(state.openEventId) || null;

  contentNode.innerHTML = [
    sectionHeader(
      "Актуальная афиша",
      "Только будущие события. Коротко, по делу и с удобным открытием полной карточки и ссылкой на детали.",
      SECTION_VISUALS.events
    ),
    eventCategoryChips(),
    eventFilterPanel(),
    statBar(buildEventStats()),
    state.events.length
      ? `<div class="list-grid">${state.events.map(safeEventPreviewCard).join("")}</div>`
      : empty("Ничего не нашлось в выбранном диапазоне. Попробуйте расширить даты."),
    opened ? renderEventModal(opened) : ""
  ].join("");
}

function renderPlaces() {
  const section = state.catalog[state.placeSection];
  const items = getActivePlaceItems();
  const selected = items.find((item) => item.id === state.selectedPlaceId) || items[0] || null;

  contentNode.innerHTML = [
    `<div class="chips">${["parks", "sights", "hotels", "excursions"].map((id) => chip(sectionLabel(id), "place-section", { section: id }, state.placeSection === id)).join("")}</div>`,
    sectionHeader(section.title, section.intro, SECTION_VISUALS[state.placeSection] || SECTION_VISUALS.places),
    statBar(buildCatalogSectionStats(state.placeSection, items, selected)),
    renderCatalogExplorerLayout({
      panelLabel: sectionLabel(state.placeSection),
      panelTitle: `${items.length || 0} точек в подборке`,
      panelText: buildCatalogCollectionText(state.placeSection, selected),
      panelBadges: buildCatalogCollectionBadges(state.placeSection, items, selected),
      cardsHtml: items.map((item) => catalogPreviewCard(state.placeSection, item, item.id === selected?.id, "place-item", { id: item.id })).join(""),
      detailHtml: selected ? placeDetailCard(state.placeSection, selected) : empty("Выберите место, чтобы открыть подробную карточку.")
    })
  ].join("");
}

function renderFood() {
  const section = state.catalog.food;
  const items = getSectionItems("food");
  const selected = items.find((item) => item.id === state.selectedFoodId) || items[0] || null;

  contentNode.innerHTML = [
    sectionHeader(section.title, section.intro, SECTION_VISUALS.food),
    statBar(buildCatalogSectionStats("food", items, selected)),
    renderCatalogExplorerLayout({
      panelLabel: "Еда",
      panelTitle: `${items.length || 0} ресторанов и бистро`,
      panelText: buildCatalogCollectionText("food", selected),
      panelBadges: buildCatalogCollectionBadges("food", items, selected),
      cardsHtml: items.map((item) => catalogPreviewCard("food", item, item.id === selected?.id, "section-item", { section: "food", id: item.id })).join(""),
      detailHtml: selected ? foodDetailCard(selected) : empty("Выберите место, чтобы открыть карточку ресторана.")
    })
  ].join("");
}

function renderActive() {
  renderSectionExplorer("active", "Выберите место для активного отдыха.");
}

function renderRoadtrip() {
  renderSectionExplorer("roadtrip", "Выберите направление для поездки.");
}

function buildEventStats() {
  const hiddenCount = Math.max(0, Number(state.totalEvents || 0) - state.events.length);
  return [
    `Период: ${state.periodLabel}`,
    state.events.length ? `Показано: ${state.events.length}` : "По фильтру пока пусто",
    hiddenCount ? `Ещё по фильтру: ${hiddenCount}` : "",
    state.syncedAt ? `Обновлено: ${formatDate(state.syncedAt)}` : "Обновление скоро"
  ];
}

function renderSectionExplorer(sectionId, emptyText) {
  const section = state.catalog[sectionId];
  const items = getSectionItems(sectionId);
  const selectedId = getSelectedSectionId(sectionId);
  const selected = items.find((item) => item.id === selectedId) || items[0] || null;

  contentNode.innerHTML = [
    sectionHeader(section.title, section.intro, SECTION_VISUALS[sectionId]),
    statBar(buildCatalogSectionStats(sectionId, items, selected)),
    renderCatalogExplorerLayout({
      panelLabel: sectionLabel(sectionId),
      panelTitle: `${items.length || 0} вариантов`,
      panelText: buildCatalogCollectionText(sectionId, selected),
      panelBadges: buildCatalogCollectionBadges(sectionId, items, selected),
      cardsHtml: items.map((item) => catalogPreviewCard(sectionId, item, item.id === selected?.id, "section-item", { section: sectionId, id: item.id })).join(""),
      detailHtml: selected ? placeDetailCard(sectionId, selected) : empty(emptyText)
    })
  ].join("");
}

function renderRoutes() {
  const routes = state.catalog.routes;
  const items = getActiveRouteItems();
  const selected = items.find((route) => route.id === state.selectedRouteId) || items[0] || null;
  const activeLevel = routes.levels.find((level) => level.id === state.routeLevel);

  contentNode.innerHTML = [
    `<div class="chips">${routes.levels.map((level) => chip(level.title, "route-level", { level: level.id }, state.routeLevel === level.id)).join("")}</div>`,
    sectionHeader("Пешие маршруты", routes.levels.find((level) => level.id === state.routeLevel)?.description || routes.intro, SECTION_VISUALS.routes),
    statBar(buildRouteSectionStats(items, selected)),
    renderCatalogExplorerLayout({
      panelLabel: "Пешие маршруты",
      panelTitle: activeLevel ? `${items.length || 0} маршрутов: ${activeLevel.title.toLowerCase()} уровень` : `${items.length || 0} маршрутов`,
      panelText: buildRouteCollectionText(selected, activeLevel),
      panelBadges: buildRouteCollectionBadges(items, selected, activeLevel),
      cardsHtml: items.map((route) => routePreviewCard(route, route.id === selected?.id)).join(""),
      detailHtml: selected ? routeDetailCard(selected) : empty("Выберите маршрут, чтобы увидеть детали и карту.")
    })
  ].join("");
}

function renderFavorites() {
  normalizeFavoriteSelection();
  const selected = state.favorites.find((item) => item.id === state.selectedFavoriteId) || null;

  contentNode.innerHTML = [
    sectionHeader("Избранное и личный план", "Сохраняйте события, парки, маршруты и места, чтобы быстро вернуться к ним позже и при необходимости сразу убрать их из плана.", SECTION_VISUALS.favorites),
    statBar(buildFavoriteSectionStats(state.favorites, selected)),
    state.favorites.length
      ? renderCatalogExplorerLayout({
        panelLabel: "Личный план",
        panelTitle: `${state.favorites.length} сохранённых карточек`,
        panelText: buildFavoriteCollectionText(selected),
        panelBadges: buildFavoriteCollectionBadges(state.favorites, selected),
        cardsHtml: state.favorites.map((item) => favoritePreviewCard(item, item.id === state.selectedFavoriteId)).join(""),
        detailHtml: selected ? favoriteDetailCard(selected) : empty("Выберите карточку, чтобы посмотреть детали.")
      })
      : empty("Пока пусто. Добавьте в избранное хотя бы одно событие или место.")
  ].join("");
}

function eventDetailCard(item) {
  const sourceButtons = (item.sources || [])
    .filter((source) => source?.url)
    .slice(0, 1)
    .map((source) => actionButton("Источник", "open", { url: source.url }));
  const dateLabel = formatEventDateOnly(item.eventDate || item.publishedAt);
  const timeLabel = formatEventTimeOnly(item.eventDate, item.eventHasExplicitTime);
  const venueLabel = eventVenueText(item);
  const fallbackImage = eventVisualUrl(item, "detail");

  return card([
    mediaImage(fallbackImage, eventCardTitle(item) || "Событие", "", fallbackImage),
    `<div class="preview-label">${escapeHtml(eventTypeLabel(item))}</div>`,
    `<h2 class="detail-title">${escapeHtml(eventCardTitle(item) || "Событие")}</h2>`,
    eventCardSummary(item) ? richTextBlock(splitSummaryParagraphs(eventCardSummary(item), 4)) : "",
    `<div class="fact-grid">
      ${dateLabel ? factBlock("Дата", dateLabel) : ""}
      ${timeLabel ? factBlock("Время", timeLabel) : ""}
      ${venueLabel ? factBlock("Место", venueLabel) : ""}
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
  const meta = [formatEventDateOnly(item.eventDate || item.publishedAt), formatEventTimeOnly(item.eventDate, item.eventHasExplicitTime), eventVenueText(item)].filter(Boolean).join(" В· ");
  const fallbackImage = eventVisualUrl(item, "compact");
  return card([
    mediaImage(fallbackImage, eventCardTitle(item) || "Событие", "compact", fallbackImage),
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

function safeEventDetailCard(item) {
  const dateLabel = formatEventDateOnly(item.eventDate || item.publishedAt);
  const timeLabel = formatEventTimeOnly(item.eventDate, item.eventHasExplicitTime);
  const venueLabel = eventVenueText(item);
  const sourceUrl = item.url || item.sources?.find((source) => source?.url)?.url || "";
  const fallbackImage = eventVisualUrl(item, "detail");

  return card([
    mediaImage(fallbackImage, eventCardTitle(item) || "Событие", "", fallbackImage),
    `<div class="preview-label">${escapeHtml(eventTypeLabel(item))}</div>`,
    `<h2 class="detail-title">${escapeHtml(eventCardTitle(item) || "Событие")}</h2>`,
    richTextBlock(eventDetailSummary(item), "event-copy"),
    `<div class="fact-grid">
      ${dateLabel ? factBlock("Дата", dateLabel) : ""}
      ${timeLabel ? factBlock("Время", timeLabel) : ""}
      ${venueLabel ? factBlock("Место", venueLabel) : ""}
    </div>`,
    actions([
      actionButton(favoriteToggleLabel(item.id), "favorite-event", { id: item.id }, isFavorite(item.id) ? "primary" : ""),
      `<button class="button ${item.eventDate ? "" : "ghost"}" data-action="remind" data-id="${escapeHtml(item.id)}" ${item.eventDate ? "" : "disabled"}>Напомнить</button>`,
      ...(item.ticketLinks || []).slice(0, 4).map((link) => actionButton(link.name, "open", { url: link.url }))
    ]),
    sourceUrl ? sourceNote(sourceUrl) : ""
  ], "active");
}

function safeEventPreviewCard(item) {
  const meta = [
    formatEventDateOnly(item.eventDate || item.publishedAt),
    formatEventTimeOnly(item.eventDate, item.eventHasExplicitTime),
    eventVenueText(item)
  ].filter(Boolean).join(" · ");
  const fallbackImage = eventVisualUrl(item, "compact");
  const isOpened = item.id === state.openEventId;

  return card([
    mediaImage(fallbackImage, eventCardTitle(item) || "Событие", "compact", fallbackImage),
    `<div class="preview-label">${escapeHtml(eventTypeLabel(item))}</div>`,
    `<h3>${escapeHtml(eventCardTitle(item) || "Событие")}</h3>`,
    meta ? `<div class="meta">${escapeHtml(meta)}</div>` : "",
    `<p class="summary-short">${escapeHtml(eventPreviewSummary(item))}</p>`,
    actions([
      actionButton(isOpened ? "Открыто" : "Открыть", "event-item", { id: item.id }, isOpened ? "primary" : ""),
      actionButton(favoriteToggleLabel(item.id), "favorite-event", { id: item.id }, isFavorite(item.id) ? "primary" : "")
    ])
  ], isOpened ? "active" : "");
}

function renderEventModal(item) {
  return `
    <div class="event-modal-shell">
      <button class="event-modal-backdrop" data-action="event-close" aria-label="Закрыть карточку"></button>
      <div class="event-modal-window" role="dialog" aria-modal="true" aria-label="${escapeHtml(eventCardTitle(item) || "Событие")}">
        <div class="event-modal-header">
          <div>
            <div class="preview-label">Полная карточка события</div>
            <h3>${escapeHtml(eventCardTitle(item) || "Событие")}</h3>
          </div>
          <button class="event-modal-close" data-action="event-close" aria-label="Закрыть">×</button>
        </div>
        ${safeEventDetailCard(item)}
      </div>
    </div>
  `;
}

function renderCatalogExplorerLayout({ panelLabel = "", panelTitle = "", panelText = "", panelBadges = [], cardsHtml = "", detailHtml = "" }) {
  return `
    <section class="two-column explorer-shell">
      <div class="explorer-sidebar">
        <article class="card explorer-panel">
          ${panelLabel ? `<div class="preview-label">${escapeHtml(panelLabel)}</div>` : ""}
          ${panelTitle ? `<h3>${escapeHtml(panelTitle)}</h3>` : ""}
          ${panelText ? `<p class="summary-short">${escapeHtml(panelText)}</p>` : ""}
          ${panelBadges.length ? `<div class="meta-badges explorer-badges">${panelBadges.map((value) => badge(value)).join("")}</div>` : ""}
        </article>
        <div class="list-grid selector-list">${cardsHtml}</div>
      </div>
      <div class="explorer-detail">${detailHtml}</div>
    </section>
  `;
}

function catalogPreviewCard(sectionId, item, isActive, action, data) {
  const attrs = Object.entries(data).map(([key, value]) => `data-${key}="${escapeHtml(value)}"`).join(" ");
  const badges = buildCatalogPreviewBadges(sectionId, item).slice(0, 3);
  const summary = trim(item.description || item.reviewSummary || item.cuisine || item.subtitle || item.title, 140);
  const fallbackImage = SECTION_VISUALS[sectionId] || SECTION_VISUALS.places;
  const previewImage = getSectionPrimaryImage(sectionId, item, fallbackImage);

  return `
    <button type="button" class="selector-card ${isActive ? "is-active" : ""}" data-action="${action}" ${attrs}>
      ${previewImage ? mediaImage(previewImage, item.title, "compact", fallbackImage) : ""}
      <div class="selector-card-head">
        <span class="preview-label">${escapeHtml(sectionLabel(sectionId))}</span>
        <span class="selector-state">${isActive ? "Открыто" : "Смотреть"}</span>
      </div>
      <div class="selector-card-title">${escapeHtml(item.title)}</div>
      ${item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : ""}
      ${summary ? `<p class="summary-short">${escapeHtml(summary)}</p>` : ""}
      ${badges.length ? `<div class="meta-badges selector-badges">${badges.map((value) => badge(value)).join("")}</div>` : ""}
    </button>
  `;
}

function placeDetailCard(sectionId, item) {
  const fallbackImage = SECTION_VISUALS[sectionId] || SECTION_VISUALS.places;
  const primaryImage = getSectionPrimaryImage(sectionId, item, fallbackImage);
  const photoLinks = getSectionPhotoLinks(sectionId, item);
  const highlightsTitle = sectionId === "active" ? "Что внутри" : "Что посмотреть";
  const detailBadges = buildCatalogDetailBadges(sectionId, item);
  const quickFacts = buildPlaceQuickFacts(sectionId, item);
  return card([
    primaryImage ? mediaImage(primaryImage, item.title, "", fallbackImage) : "",
    `<div class="detail-topline">
      <div class="preview-label">${escapeHtml(sectionLabel(sectionId))}</div>
      ${detailBadges.length ? `<div class="meta-badges">${detailBadges.map((value) => badge(value)).join("")}</div>` : ""}
    </div>`,
    `<h2>${escapeHtml(item.title)}</h2>`,
    item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : "",
    quickFacts.length ? detailQuickGrid(quickFacts) : "",
    richTextBlock(item.description),
    `<div class="fact-grid">
      ${item.highlights?.length ? factListBlock(highlightsTitle, item.highlights) : ""}
      ${item.bestFor ? factBlock(sectionId === "roadtrip" ? "Зачем ехать" : "Кому подойдет", item.bestFor) : ""}
      ${item.timing ? factBlock("Когда лучше", item.timing) : ""}
      ${item.reviewSummary ? factBlock("По отзывам", item.reviewSummary) : ""}
      ${item.reviewRating ? factBlock("Рейтинг", `${item.reviewRating} / 5 · ${item.reviewCount || "без числа отзывов"}`) : ""}
      ${item.foodNearby ? factBlock("Где перекусить", item.foodNearby) : ""}
      ${item.howToGet ? factBlock("Как добраться", item.howToGet) : ""}
      ${photoLinks.length ? factButtonsBlock("Подборка фото", photoLinks) : ""}
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
  const detailBadges = buildCatalogDetailBadges("food", item);
  const quickFacts = buildFoodQuickFacts(item);
  const fallbackImage = SECTION_VISUALS.food;
  const primaryImage = getSectionPrimaryImage("food", item, fallbackImage);
  const photoLinks = getSectionPhotoLinks("food", item);
  return card([
    primaryImage ? mediaImage(primaryImage, item.title, "", fallbackImage) : "",
    `<div class="detail-topline">
      <div class="preview-label">Еда</div>
      ${detailBadges.length ? `<div class="meta-badges">${detailBadges.map((value) => badge(value)).join("")}</div>` : ""}
    </div>`,
    `<h2>${escapeHtml(item.title)}</h2>`,
    item.subtitle ? `<div class="meta">${escapeHtml(item.subtitle)}</div>` : "",
    quickFacts.length ? detailQuickGrid(quickFacts) : "",
    richTextBlock(item.description),
    `<div class="fact-grid">
      ${photoLinks.length ? factButtonsBlock("Подборка фото", photoLinks) : ""}
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

function detailQuickGrid(items) {
  return `<div class="detail-quick-grid">${items
    .filter((item) => item?.label && item?.value)
    .map((item) => `<section class="detail-quick-card"><p class="subtle-title">${escapeHtml(item.label)}</p><p>${escapeHtml(item.value)}</p></section>`)
    .join("")}</div>`;
}

function buildCatalogCollectionText(sectionId, selected) {
  if (sectionId === "food") {
    return selected
      ? `Сейчас в фокусе ${selected.title}: можно быстро посмотреть кухню, ключевые блюда, отзывы и как удобнее добраться.`
      : "Выберите место, чтобы быстро сравнить кухню, атмосферу и логистику.";
  }

  if (sectionId === "roadtrip") {
    return selected
      ? `Сейчас открыт маршрут до ${selected.title}: внутри есть акценты по дороге, времени и формату поездки.`
      : "Выберите направление, чтобы увидеть, зачем туда ехать и как лучше строить выезд.";
  }

  return selected
    ? `Сейчас открыта карточка ${selected.title}: внутри только главное — фото, сильные стороны, логистика и полезные ориентиры.`
    : "Выберите место, чтобы открыть краткий, но полезный гид без лишнего текста.";
}

function buildCatalogCollectionBadges(sectionId, items, selected) {
  const badges = [];
  const photoCount = getSectionPhotoLinks(sectionId, selected).length;

  if (items?.length) badges.push(`${items.length} в подборке`);
  if (photoCount) badges.push(`${photoCount} фото`);
  if (selected?.mapUrl) badges.push(sectionId === "food" ? "Есть карта" : "Есть маршрут");
  if (sectionId === "food" && selected?.reviewUrl) badges.push("Есть отзывы");
  if (sectionId === "roadtrip") badges.push("На авто удобнее");

  return badges.slice(0, 4);
}

function buildCatalogSectionStats(sectionId, items, selected) {
  const stats = [];
  const photoCount = getSectionPhotoLinks(sectionId, selected).length;

  if (items?.length) {
    stats.push(sectionId === "food" ? `${items.length} мест для еды` : `${items.length} точек в разделе`);
  }

  if (selected?.subtitle) stats.push(selected.subtitle);
  if (photoCount) stats.push(`${photoCount} фото`);
  if (selected?.reviewUrl) stats.push("Есть отзывы");
  if (selected?.mapUrl) stats.push(sectionId === "food" ? "Карта под рукой" : "Маршрут под рукой");

  return stats.slice(0, 4);
}

function buildCatalogPreviewBadges(sectionId, item) {
  if (sectionId === "food") {
    return [
      item.cuisine ? trim(item.cuisine, 30) : "",
      item.signatureDishes?.[0] || "",
      item.reviewUrl ? "Отзывы" : "",
      item.mapUrl ? "Карта" : ""
    ].filter(Boolean);
  }

  return [
    item.highlights?.[0] || item.features?.[0] || "",
    item.foodNearby ? "Есть где перекусить" : "",
    item.bestFor ? trim(item.bestFor, 28) : "",
    item.mapUrl ? "Маршрут" : ""
  ].filter(Boolean);
}

function buildCatalogDetailBadges(sectionId, item) {
  if (sectionId === "food") {
    return [
      item.cuisine ? trim(item.cuisine, 36) : "",
      item.signatureDishes?.length ? `${item.signatureDishes.length} блюда в фокусе` : "",
      item.reviewSource ? `Отзывы: ${item.reviewSource}` : ""
    ].filter(Boolean);
  }

  return [
    item.highlights?.length ? `${item.highlights.length} акцента` : "",
    item.reviewRating ? `${item.reviewRating} / 5` : "",
    item.foodNearby ? "Можно совместить с едой" : ""
  ].filter(Boolean);
}

function buildPlaceQuickFacts(sectionId, item) {
  return [
    {
      label: sectionId === "roadtrip" ? "Формат" : "Раздел",
      value: sectionId === "roadtrip" ? "Поездка на машине" : sectionLabel(sectionId)
    },
    {
      label: sectionId === "roadtrip" ? "Почему ехать" : "Лучше для",
      value: trim(item.bestFor || item.highlights?.[0] || item.subtitle || "", 88)
    },
    {
      label: "Логистика",
      value: trim(item.howToGet || item.timing || item.foodNearby || "", 88)
    }
  ].filter((item) => item.value);
}

function buildFoodQuickFacts(item) {
  return [
    {
      label: "Кухня",
      value: trim(item.cuisine || item.subtitle || "", 88)
    },
    {
      label: "Стоит взять",
      value: trim((item.signatureDishes || []).slice(0, 2).join(", "), 88)
    },
    {
      label: "Формат",
      value: trim(item.features?.[0] || item.interior || item.subtitle || "", 88)
    }
  ].filter((item) => item.value);
}

function routePreviewCard(route, isActive) {
  const badges = buildRoutePreviewBadges(route).slice(0, 3);
  const summary = trim(route.description || route.foodNearby || route.howToGet || route.subtitle || route.title, 150);
  const previewImage = getSectionPrimaryImage("routes", route, SECTION_VISUALS.routes);

  return `
    <button type="button" class="selector-card ${isActive ? "is-active" : ""}" data-action="route-item" data-id="${escapeHtml(route.id)}">
      ${previewImage ? mediaImage(previewImage, route.title, "compact", SECTION_VISUALS.routes) : ""}
      <div class="selector-card-head">
        <span class="preview-label">Пеший маршрут</span>
        <span class="selector-state">${isActive ? "Открыто" : "Смотреть"}</span>
      </div>
      <div class="selector-card-title">${escapeHtml(route.title)}</div>
      ${route.subtitle ? `<div class="meta">${escapeHtml(route.subtitle)}</div>` : ""}
      ${summary ? `<p class="summary-short">${escapeHtml(summary)}</p>` : ""}
      ${badges.length ? `<div class="meta-badges selector-badges">${badges.map((value) => badge(value)).join("")}</div>` : ""}
    </button>
  `;
}

function routeDetailCard(route) {
  const detailBadges = buildRouteDetailBadges(route);
  const quickFacts = buildRouteQuickFacts(route);
  const primaryImage = getSectionPrimaryImage("routes", route, SECTION_VISUALS.routes);
  const photoLinks = getSectionPhotoLinks("routes", route);

  return card([
    primaryImage ? mediaImage(primaryImage, route.title, "", SECTION_VISUALS.routes) : "",
    `<div class="detail-topline">
      <div class="preview-label">Пеший маршрут</div>
      ${detailBadges.length ? `<div class="meta-badges">${detailBadges.map((value) => badge(value)).join("")}</div>` : ""}
    </div>`,
    `<h2>${escapeHtml(route.title)}</h2>`,
    route.subtitle ? `<div class="meta">${escapeHtml(route.subtitle)}</div>` : "",
    quickFacts.length ? detailQuickGrid(quickFacts) : "",
    richTextBlock(route.description),
    `<div class="fact-grid">
      ${route.stops?.length ? factListBlock("Точки маршрута", route.stops) : ""}
      ${route.foodNearby ? factBlock("Где сделать остановку на еду", route.foodNearby) : ""}
      ${route.howToGet ? factBlock("Старт и логистика", route.howToGet) : ""}
      ${photoLinks.length ? factButtonsBlock("Подборка фото", photoLinks) : ""}
    </div>`,
    actions([
      actionButton(favoriteToggleLabel(routeFavoriteId(route.id)), "favorite-route", { id: route.id }, isFavorite(routeFavoriteId(route.id)) ? "primary" : ""),
      route.mapUrl ? actionButton("Открыть карту", "open", { url: route.mapUrl }, "primary") : "",
      route.sourceUrl ? actionButton("Источник", "open", { url: route.sourceUrl }) : ""
    ])
  ], "active");
}

function buildRouteCollectionText(selected, activeLevel) {
  if (selected) {
    return `Сейчас открыт маршрут ${selected.title}. Внутри есть длина, темп прогулки, точки по пути и понятная логистика старта.`;
  }

  if (activeLevel) {
    return `Выберите ${activeLevel.title.toLowerCase()} маршрут, чтобы быстро понять длину прогулки, ритм и главные остановки.`;
  }

  return "Выберите маршрут, чтобы быстро сравнить длину, темп и ключевые точки прогулки.";
}

function buildRouteCollectionBadges(items, selected, activeLevel) {
  const badges = [];

  if (activeLevel) badges.push(routeLevelLabel(activeLevel.id));
  if (items?.length) badges.push(`${items.length} маршрутов`);
  if (selected?.duration) badges.push(selected.duration);
  if (selected?.stops?.length) badges.push(`${selected.stops.length} точек`);

  return badges.slice(0, 4);
}

function buildRouteSectionStats(items, selected) {
  const stats = [];

  if (items?.length) stats.push(`${items.length} маршрутов в уровне`);
  if (selected?.subtitle) stats.push(selected.subtitle);
  if (selected?.duration) stats.push(selected.duration);
  if (selected?.stops?.length) stats.push(`${selected.stops.length} остановок`);

  return stats.slice(0, 4);
}

function buildRoutePreviewBadges(route) {
  return [
    routeLevelLabel(route.level),
    route.duration || "",
    route.stops?.length ? `${route.stops.length} точек` : "",
    route.foodNearby ? "Есть остановка на еду" : ""
  ].filter(Boolean);
}

function buildRouteDetailBadges(route) {
  return [
    routeLevelLabel(route.level),
    route.duration || "",
    route.stops?.length ? `${route.stops.length} точек маршрута` : ""
  ].filter(Boolean);
}

function buildRouteQuickFacts(route) {
  return [
    {
      label: "Сложность",
      value: routeLevelLabel(route.level)
    },
    {
      label: "Темп",
      value: trim(route.duration || route.subtitle || "", 88)
    },
    {
      label: "Маршрут",
      value: trim(route.howToGet || route.foodNearby || "", 88)
    }
  ].filter((item) => item.value);
}

async function toggleFavorite(payload) {
  if (!payload) return;

  try {
    const result = await api("/api/favorites/toggle", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.favorites = result.favorites || [];
    normalizeFavoriteSelection();
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
    state.openEventId = favorite.id;
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
  syncUrl();
  render();
}

function eventFavoritePayload(item) {
  if (!item) return null;

  return {
    type: "event",
    id: item.id,
    title: eventCardTitle(item) || item.title || "Событие",
    subtitle: eventVenueText(item) || "",
    summary: eventPreviewSummary(item),
    imageUrl: eventVisualUrl(item, "detail"),
    url: item.url,
    eventDate: item.eventDate,
    eventHasExplicitTime: item.eventHasExplicitTime,
    venueTitle: item.venueTitle || eventVenueText(item)
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
    summary: trim(item.description || item.reviewSummary || item.cuisine || item.bestFor || item.title, 180),
    imageUrl: item.imageUrl || SECTION_VISUALS[sectionId] || SECTION_VISUALS.places,
    url: item.sourceUrl,
    mapUrl: item.mapUrl,
    reviewUrl: item.reviewUrl
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
    summary: trim(route.description || route.foodNearby || route.howToGet || route.title, 180),
    imageUrl: route.imageUrl || SECTION_VISUALS.routes,
    url: route.sourceUrl,
    mapUrl: route.mapUrl,
    duration: route.duration,
    level: route.level
  };
}

function normalizeFavoriteSelection() {
  if (!state.favorites.length) {
    state.selectedFavoriteId = null;
    return;
  }

  if (!state.favorites.some((item) => item.id === state.selectedFavoriteId)) {
    state.selectedFavoriteId = state.favorites[0]?.id || null;
  }
}

function favoritePreviewCard(item, isActive) {
  const snapshot = getFavoriteSnapshot(item);
  const badges = buildFavoritePreviewBadges(snapshot).slice(0, 3);
  const imageUrl = snapshot.imageUrl || snapshot.fallbackImage;

  return `
    <button type="button" class="selector-card ${isActive ? "is-active" : ""}" data-action="favorite-focus" data-id="${escapeHtml(item.id)}">
      ${imageUrl ? mediaImage(imageUrl, snapshot.title, "compact", snapshot.fallbackImage) : ""}
      <div class="selector-card-head">
        <span class="preview-label">${escapeHtml(snapshot.typeLabel)}</span>
        <span class="selector-state">${isActive ? "Открыто" : "Смотреть"}</span>
      </div>
      <div class="selector-card-title">${escapeHtml(snapshot.title)}</div>
      ${snapshot.metaLine ? `<div class="meta">${escapeHtml(snapshot.metaLine)}</div>` : ""}
      ${snapshot.summary ? `<p class="summary-short">${escapeHtml(snapshot.summary)}</p>` : ""}
      ${badges.length ? `<div class="meta-badges selector-badges">${badges.map((value) => badge(value)).join("")}</div>` : ""}
    </button>
  `;
}

function favoriteDetailCard(item) {
  const snapshot = getFavoriteSnapshot(item);
  const detailBadges = buildFavoriteDetailBadges(snapshot);
  const quickFacts = buildFavoriteQuickFacts(snapshot);
  const imageUrl = snapshot.imageUrl || snapshot.fallbackImage;
  const highlightTitle = snapshot.type === "route"
    ? "Точки маршрута"
    : snapshot.type === "catalog" && snapshot.sectionId === "food"
      ? "Ключевые блюда"
      : "Что важно";

  return card([
    imageUrl ? mediaImage(imageUrl, snapshot.title, "", snapshot.fallbackImage) : "",
    `<div class="detail-topline">
      <div class="preview-label">Личный план</div>
      ${detailBadges.length ? `<div class="meta-badges">${detailBadges.map((value) => badge(value)).join("")}</div>` : ""}
    </div>`,
    `<h2>${escapeHtml(snapshot.title)}</h2>`,
    snapshot.metaLine ? `<div class="meta">${escapeHtml(snapshot.metaLine)}</div>` : "",
    quickFacts.length ? detailQuickGrid(quickFacts) : "",
    richTextBlock(snapshot.description || snapshot.summary || "Карточка сохранена в вашем плане."),
    `<div class="fact-grid">
      ${snapshot.dateLabel ? factBlock("Дата", snapshot.dateLabel) : ""}
      ${snapshot.timeLabel ? factBlock("Время", snapshot.timeLabel) : ""}
      ${snapshot.venue ? factBlock("Место", snapshot.venue) : ""}
      ${snapshot.reviewSummary ? factBlock("По отзывам", snapshot.reviewSummary) : ""}
      ${snapshot.howToGet ? factBlock("Как добраться", snapshot.howToGet) : ""}
      ${snapshot.interior ? factBlock("Интерьер", snapshot.interior) : ""}
      ${snapshot.highlights?.length ? factListBlock(highlightTitle, snapshot.highlights) : ""}
      ${snapshot.photoLinks?.length ? factButtonsBlock("Подборка фото", snapshot.photoLinks) : ""}
    </div>`,
    actions([
      actionButton("Открыть карточку", "favorite-open", { id: item.id }, "primary"),
      snapshot.type === "event" && snapshot.eventId && snapshot.eventDate
        ? `<button class="button" data-action="remind" data-id="${escapeHtml(snapshot.eventId)}">Напомнить</button>`
        : "",
      actionButton("Убрать из плана", "favorite-remove", { id: item.id }),
      snapshot.mapUrl ? actionButton("Открыть карту", "open", { url: snapshot.mapUrl }) : "",
      snapshot.reviewUrl ? actionButton(snapshot.reviewSource ? `Отзывы: ${snapshot.reviewSource}` : "Отзывы", "open", { url: snapshot.reviewUrl }) : "",
      snapshot.sourceUrl ? actionButton("Источник", "open", { url: snapshot.sourceUrl }) : ""
    ])
  ], "active");
}

function getFavoriteSnapshot(item) {
  if (!item) {
    return {
      id: "",
      type: "unknown",
      typeLabel: "Избранное",
      title: "Карточка",
      summary: "",
      description: "",
      imageUrl: SECTION_VISUALS.favorites,
      fallbackImage: SECTION_VISUALS.favorites,
      metaLine: ""
    };
  }

  if (item.type === "event") {
    const current = findEvent(item.id);
    const dateLabel = formatEventDateOnly(current?.eventDate || item.eventDate);
    const timeLabel = formatEventTimeOnly(
      current?.eventDate || item.eventDate,
      current?.eventHasExplicitTime ?? item.eventHasExplicitTime ?? true
    );
    const venue = current ? eventVenueText(current) : (item.venueTitle || "");
    const typeLabel = current ? eventTypeLabel(current) : favoriteTypeLabel(item.type, item.sectionId);
    const title = current ? (eventCardTitle(current) || item.title || "Событие") : (item.title || "Событие");
    const summary = current ? eventPreviewSummary(current) : trim(item.summary || item.title || "", 170);

    return {
      id: item.id,
      eventId: item.id,
      type: "event",
      typeLabel,
      title,
      summary,
      description: current ? eventDetailSummary(current) : summary,
      imageUrl: current ? eventVisualUrl(current, "detail") : (item.imageUrl || SECTION_VISUALS.events),
      fallbackImage: current ? eventVisualUrl(current, "detail") : SECTION_VISUALS.events,
      metaLine: [dateLabel, timeLabel, venue].filter(Boolean).join(" · "),
      eventDate: current?.eventDate || item.eventDate || "",
      dateLabel,
      timeLabel,
      venue,
      sourceUrl: current?.url || item.url || "",
      mapUrl: item.mapUrl || "",
      addedAt: item.addedAt || ""
    };
  }

  if (item.type === "catalog") {
    const current = getSectionItems(item.sectionId).find((value) => value.id === item.itemId);
    const sectionName = sectionLabel(item.sectionId);
    const fallbackImage = SECTION_VISUALS[item.sectionId] || SECTION_VISUALS.places;
    const photoLinks = getSectionPhotoLinks(item.sectionId, current || item);
    const imageUrl = getSectionPrimaryImage(item.sectionId, current || item, fallbackImage) || item.imageUrl || fallbackImage;
    const isFood = item.sectionId === "food";
    const highlights = isFood
      ? (current?.signatureDishes || [])
      : (current?.highlights || current?.features || []);
    const summary = trim(
      current?.description
        || current?.reviewSummary
        || current?.bestFor
        || current?.cuisine
        || item.summary
        || item.subtitle
        || item.title,
      180
    );

    return {
      id: item.id,
      type: "catalog",
      typeLabel: sectionName,
      sectionId: item.sectionId,
      title: current?.title || item.title || sectionName,
      summary,
      description: current?.description || current?.reviewSummary || summary,
      imageUrl,
      fallbackImage,
      metaLine: [sectionName, current?.subtitle || item.subtitle || ""].filter(Boolean).join(" · "),
      sourceLabel: current?.reviewSource || sectionName,
      sourceUrl: current?.sourceUrl || item.url || "",
      mapUrl: current?.mapUrl || item.mapUrl || "",
      reviewUrl: current?.reviewUrl || item.reviewUrl || "",
      reviewSource: current?.reviewSource || "",
      reviewSummary: current?.reviewSummary || "",
      howToGet: current?.howToGet || "",
      interior: current?.interior || "",
      highlights,
      photoLinks,
      cuisine: current?.cuisine || "",
      bestFor: current?.bestFor || "",
      addedAt: item.addedAt || ""
    };
  }

  if (item.type === "route") {
    const current = state.catalog?.routes?.items?.find((value) => value.id === item.itemId);
    const level = current?.level || item.level || "";
    const duration = current?.duration || item.duration || "";
    const summary = trim(current?.description || current?.foodNearby || current?.howToGet || item.summary || item.subtitle || item.title, 180);
    const fallbackImage = SECTION_VISUALS.routes;
    const photoLinks = getSectionPhotoLinks("routes", current || item);
    const imageUrl = getSectionPrimaryImage("routes", current || item, fallbackImage) || item.imageUrl || fallbackImage;

    return {
      id: item.id,
      type: "route",
      typeLabel: "Пеший маршрут",
      title: current?.title || item.title || "Маршрут",
      summary,
      description: current?.description || summary,
      imageUrl,
      fallbackImage,
      metaLine: [level ? routeLevelLabel(level) : "", duration, current?.subtitle || item.subtitle || ""].filter(Boolean).join(" · "),
      sourceLabel: "Маршрут по Казани",
      sourceUrl: current?.sourceUrl || item.url || "",
      mapUrl: current?.mapUrl || item.mapUrl || "",
      howToGet: current?.howToGet || "",
      highlights: current?.stops || [],
      photoLinks,
      duration,
      level,
      addedAt: item.addedAt || ""
    };
  }

  return {
    id: item.id,
    type: item.type || "unknown",
    typeLabel: favoriteTypeLabel(item.type, item.sectionId),
    title: item.title || "Карточка",
    summary: trim(item.summary || item.subtitle || item.title || "", 170),
    description: trim(item.summary || item.subtitle || item.title || "", 320),
    imageUrl: item.imageUrl || SECTION_VISUALS.favorites,
    fallbackImage: SECTION_VISUALS.favorites,
    metaLine: item.subtitle || "",
    sourceUrl: item.url || "",
    mapUrl: item.mapUrl || "",
    addedAt: item.addedAt || ""
  };
}

function buildFavoriteSectionStats(items, selected) {
  const counts = countFavoritesByType(items);
  const stats = [];

  if (items?.length) stats.push(`${items.length} в личном плане`);
  if (counts.event) stats.push(`${counts.event} событий`);
  if (counts.catalog) stats.push(`${counts.catalog} мест`);
  if (counts.route) stats.push(`${counts.route} маршрутов`);
  if (!counts.route && selected?.metaLine) stats.push(selected.metaLine);

  return stats.slice(0, 4);
}

function buildFavoriteCollectionText(selected) {
  if (!selected) {
    return "Здесь собраны все сохранённые события, места и маршруты. Можно быстро открыть нужную карточку или убрать лишнее из плана.";
  }

  const snapshot = getFavoriteSnapshot(selected);
  return `Сейчас в фокусе ${snapshot.title}. Внутри собраны только главные ориентиры: краткое описание, логистика, карта и быстрый переход к деталям.`;
}

function buildFavoriteCollectionBadges(items, selected) {
  const counts = countFavoritesByType(items);
  const badges = [];

  if (counts.event) badges.push(`${counts.event} событий`);
  if (counts.catalog) badges.push(`${counts.catalog} мест`);
  if (counts.route) badges.push(`${counts.route} маршрутов`);

  if (selected) {
    const snapshot = getFavoriteSnapshot(selected);
    if (snapshot.typeLabel) badges.push(snapshot.typeLabel);
    if (snapshot.dateLabel) badges.push(snapshot.dateLabel);
    else if (snapshot.mapUrl) badges.push("Есть карта");
  }

  return badges.slice(0, 4);
}

function buildFavoritePreviewBadges(snapshot) {
  if (snapshot.type === "event") {
    return [snapshot.dateLabel, snapshot.timeLabel, snapshot.venue].filter(Boolean);
  }

  if (snapshot.type === "route") {
    return [
      snapshot.level ? routeLevelLabel(snapshot.level) : "",
      snapshot.duration || "",
      snapshot.mapUrl ? "Карта" : ""
    ].filter(Boolean);
  }

  return [
    snapshot.typeLabel,
    snapshot.cuisine ? trim(snapshot.cuisine, 28) : "",
    snapshot.reviewUrl ? "Отзывы" : "",
    snapshot.mapUrl ? "Карта" : ""
  ].filter(Boolean);
}

function buildFavoriteDetailBadges(snapshot) {
  return [
    snapshot.typeLabel,
    snapshot.addedAt ? `В плане с ${formatFavoriteAddedDate(snapshot.addedAt)}` : "",
    snapshot.reviewUrl ? "Есть отзывы" : "",
    snapshot.mapUrl ? "Есть карта" : ""
  ].filter(Boolean).slice(0, 4);
}

function buildFavoriteQuickFacts(snapshot) {
  return [
    {
      label: "Тип",
      value: snapshot.typeLabel
    },
    {
      label: snapshot.type === "event" ? "Когда" : "Формат",
      value: trim(snapshot.metaLine || snapshot.summary || "", 88)
    },
    {
      label: "Добавлено",
      value: snapshot.addedAt ? formatFavoriteAddedDate(snapshot.addedAt) : ""
    }
  ].filter((item) => item.value);
}

function countFavoritesByType(items) {
  return (items || []).reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, { event: 0, catalog: 0, route: 0 });
}

function formatFavoriteAddedDate(value) {
  if (!value) return "";

  return new Date(value).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long"
  });
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

  if (state.activeTab === "events" && state.openEventId) {
    next.set("event", state.openEventId);
  }

  if (state.activeTab === "favorites" && state.selectedFavoriteId) {
    next.set("favorite", state.selectedFavoriteId);
  }

  if (state.activeTab === "events" && state.eventCategory && state.eventCategory !== "all") {
    next.set("category", state.eventCategory);
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
  const filtered = (items || []).filter(Boolean);
  if (!filtered.length) return "";
  return `<div class="stat-row">${filtered.map((item) => `<span class="stat-pill">${escapeHtml(item)}</span>`).join("")}</div>`;
}

function eventCategoryChips() {
  const categories = [
    { id: "all", label: "Все" },
    { id: "expected", label: "Самые ожидаемые" },
    { id: "concert", label: "Концерты" },
    { id: "theatre", label: "Спектакли" },
    { id: "show", label: "Шоу" },
    { id: "festival", label: "Фестивали" },
    { id: "musical", label: "Мюзиклы" },
    { id: "standup", label: "Стендап" },
    { id: "sport", label: "Спорт" },
    { id: "exhibition", label: "Выставки" },
    { id: "kids", label: "Детям" },
    { id: "excursion", label: "Экскурсии" }
  ];

  return `<div class="chips">${categories.map((item) => chip(item.label, "event-category", { category: item.id }, state.eventCategory === item.id)).join("")}</div>`;
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
  return `<section class="fact"><p class="subtle-title">${escapeHtml(title)}</p><div class="photo-grid">${links
    .map(
      (link) => {
        const previewUrl = resolveMediaUrl(link.url);
        return `<a class="photo-tile" href="${escapeHtml(link.url)}" target="_blank" rel="noopener" style="background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02)), url('${escapeHtml(previewUrl)}'), url('./brand/welcome-kazan-event-radar-640x360.png');"><span>${escapeHtml(link.label)}</span></a>`;
      }
    )
    .join("")}</div></section>`;
}

function sourceNote(url) {
  return `<p class="detail-source-note">Подробности и билеты: <button type="button" class="inline-source-link" data-action="open" data-url="${escapeHtml(url)}">источник</button></p>`;
}

function badge(value) {
  return `<span class="meta-badge">${escapeHtml(value)}</span>`;
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function mediaImage(url, alt, extraClass = "", fallbackUrl = "") {
  const resolvedUrl = resolveMediaUrl(url);
  const resolvedFallbackUrl = resolveMediaUrl(fallbackUrl);
  const fallbackAttrs = resolvedFallbackUrl
    ? ` data-fallback="${escapeHtml(resolvedFallbackUrl)}" onerror="if(this.dataset.fallback&&this.src!==this.dataset.fallback){this.src=this.dataset.fallback;}"`
    : "";

  return `<div class="media-frame ${extraClass}"><img src="${escapeHtml(resolvedUrl)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer"${fallbackAttrs}></div>`;
}

function primaryItemImage(item, fallbackUrl = "") {
  return firstPhotoUrl(item) || item?.imageUrl || item?.externalPreviewUrl || fallbackUrl || "";
}

function firstPhotoUrl(item) {
  if (!Array.isArray(item?.photoLinks)) return "";
  return item.photoLinks.find((link) => String(link?.url || "").trim())?.url || "";
}

function getSectionPrimaryImage(sectionId, item, fallbackUrl = "") {
  const photoLinks = getSectionPhotoLinks(sectionId, item);
  return photoLinks[0]?.url || item?.imageUrl || item?.externalPreviewUrl || fallbackUrl || "";
}

function getSectionPhotoLinks(sectionId, item) {
  if (!item?.id || !sectionId) {
    return getFallbackPhotoLinks(item);
  }

  const manifestLinks = PHOTO_MANIFEST?.[sectionId]?.[item.id];
  if (Array.isArray(manifestLinks) && manifestLinks.length) {
    return manifestLinks;
  }

  return getFallbackPhotoLinks(item);
}

function getFallbackPhotoLinks(item) {
  const candidates = [item?.imageUrl, item?.externalPreviewUrl]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);

  return candidates.map((url, index) => ({
    label: `Фото ${index + 1}`,
    url
  }));
}

function resolveMediaUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) return raw;
  if (!/^https?:\/\//i.test(raw)) return raw;
  if (!apiBaseUrl) return raw;
  return `${apiBaseUrl}/api/image?url=${encodeURIComponent(raw)}`;
}

function richTextBlock(text, extraClass = "") {
  const paragraphs = String(text || "")
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!paragraphs.length) return "";

  return `<div class="card-copy ${extraClass}">${paragraphs.map((part) => `<p>${escapeHtml(part)}</p>`).join("")}</div>`;
}

function eventTypeLabel(item) {
  if (isFestivalLikeEvent(item)) return "Фестиваль";
  if (item.kind === "concert") return "Концерт";
  if (item.kind === "theatre") return "Спектакль";
  if (item.kind === "show") return "Шоу";
  if (item.kind === "festival") return "Фестиваль";
  if (item.kind === "standup") return "Стендап";
  if (item.kind === "sport") return "Спорт";
  if (item.kind === "exhibition") return "Выставка";
  if (item.kind === "excursion") return "Экскурсия";
  if (item.kind === "musical") return "Мюзикл";
  if (item.kind === "kids") return "Семейная программа";

  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  if (text.includes("матч") || text.includes("хоккей") || text.includes("футбол") || text.includes("волейбол") || text.includes("баскетбол")) return "Спорт";
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

function isFestivalLikeEvent(item) {
  const text = compactTextFingerprint(`${item?.title || ""} ${item?.summary || ""} ${item?.shortSummary || ""} ${item?.sourceName || ""} ${item?.url || ""}`);
  return text.includes("фестив") || text.includes("festival");
}

function eventCardTitle(item) {
  const base = trim(firstMeaningfulLine(item.title || item.summary || "Событие"), 84)
    .replace(/^\d{1,2}[.:]\d{2}\s*/u, "")
    .replace(/^\d{1,2}\s+[а-яё]+\s*/iu, "")
    .replace(/^(концерт|спектакль|мастер-класс|выставка|лекция|экскурсия|стендап|фестиваль|шоу|мюзикл|матч|турнир|спортивное событие)\s*/iu, "")
    .trim();

  if (!base) return item.title || "Событие";
  return base;
}

function eventCardSummary(item) {
  return trim((item.shortSummary || item.summary || item.title || "").replace(/\s+/g, " "), 280);
}

function eventDetailSummary(item) {
  return [
    ...buildEventLeadParagraphs(item, 3),
    buildSafeEventScheduleLine(item),
    buildSafeEventMoodLine(item)
  ].filter(Boolean).join("\n\n");
}

function eventPreviewSummary(item) {
  return trim(buildEventLeadParagraphs(item, 1)[0] || buildSafeEventMoodLine(item), 170);
}

function buildEventLeadParagraphs(item, maxParagraphs = 2) {
  const titleFingerprint = compactTextFingerprint(eventCardTitle(item) || "");
  const sourceText = normalizeEventLeadText(item.rawSummary || item.summary || item.shortSummary || item.subtitle || "");
  const sentences = sourceText
    .match(/[^.!?]+[.!?]?/g)
    ?.map((part) => trim(part, 190))
    .filter(Boolean) || [];
  const paragraphs = [];

  for (const sentence of sentences) {
    const fingerprint = compactTextFingerprint(sentence);
    if (!fingerprint || fingerprint === titleFingerprint) continue;
    if (paragraphs.some((entry) => compactTextFingerprint(entry) === fingerprint)) continue;
    paragraphs.push(sentence);
    if (paragraphs.length >= maxParagraphs) return paragraphs;
  }

  if (!paragraphs.length && sourceText) {
    const fallback = trim(sourceText, 190);
    if (compactTextFingerprint(fallback) !== titleFingerprint) {
      paragraphs.push(fallback);
    }
  }

  return paragraphs.slice(0, maxParagraphs);
}

function normalizeEventLeadText(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/В афише Казани[^.?!]*[.?!]/giu, "")
    .replace(/\s+/g, " ")
    .replace(/Подробности[^.]*$/iu, "")
    .replace(/Подробности и билеты[^.]*$/iu, "")
    .trim();
}

function compactTextFingerprint(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[«»"']/g, "")
    .replace(/[^a-zа-яё0-9]+/giu, " ")
    .trim();
}

function buildSafeEventHeadline(item) {
  const title = eventCardTitle(item) || "Событие";
  return `В афише Казани — ${eventTypeLabel(item).toLowerCase()} ${quoteEventTitle(title)}.`;
}

function buildSafeEventScheduleLine(item) {
  const dateLabel = formatEventDateOnly(item.eventDate || item.publishedAt);
  const timeLabel = formatEventTimeOnly(item.eventDate, item.eventHasExplicitTime);
  const venueLabel = eventVenueText(item);

  if (dateLabel && timeLabel && venueLabel) return `Дата и место: ${dateLabel}, ${timeLabel}, ${venueLabel}.`;
  if (dateLabel && venueLabel) return `Дата и место: ${dateLabel}, ${venueLabel}.`;
  if (dateLabel && timeLabel) return `Дата: ${dateLabel}, ${timeLabel}.`;
  if (dateLabel) return `Дата: ${dateLabel}.`;
  if (venueLabel) return `Площадка: ${venueLabel}.`;
  return "Точное расписание лучше заранее проверить у организатора.";
}

function buildSafeEventMoodLine(item) {
  return {
    concert: "Подойдет для вечернего выхода, если хочется живой музыки и понятной логистики.",
    theatre: "Хороший вариант для спокойного театрального вечера без перегруженного описания.",
    show: "Подойдет тем, кто ищет более яркий и визуальный формат отдыха в городе.",
    festival: "Удобный выбор, если хочется провести в городе большой и насыщенный день с программой на несколько часов.",
    standup: "Можно добавить в план для легкого вечернего выхода с друзьями или вдвоем.",
    sport: "Хороший вариант для живой атмосферы, эмоций трибун и понятного сценария выхода без лишнего текста.",
    exhibition: "Удобный вариант, если хочется спокойного культурного маршрута в своем темпе.",
    excursion: "Подойдет тем, кто хочет узнать город или тему глубже и провести время содержательно.",
    musical: "Хороший выбор для тех, кто любит сцену, музыку и большой постановочный формат.",
    kids: "Можно рассмотреть как семейный выход, если нужен понятный формат на свободный день."
  }[item.kind] || "Можно добавить в личный план, если хочется собрать насыщенный выход по городу.";
}

function quoteEventTitle(value) {
  const title = String(value || "").trim();
  if (!title) return "";
  if (/^[«"][^«»"]+[»"]$/u.test(title)) return title;
  if (/[«»"]/u.test(title)) return title;
  return `«${title}»`;
}

function eventVisualUrl(item, variant = "detail") {
  const cacheKey = `${variant}:${item.id || item.title || "event"}`;
  if (!eventVisualCache.has(cacheKey)) {
    eventVisualCache.set(cacheKey, `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(buildEventPosterSvg(item, variant))}`);
  }

  return eventVisualCache.get(cacheKey);
}

function buildEventPosterSvg(item, variant = "detail") {
  const palette = eventPosterPalette(item.kind);
  const titleLines = wrapPosterText(eventCardTitle(item) || "Событие в Казани", variant === "compact" ? 20 : 26, 3);
  const metaLines = wrapPosterText(
    [formatEventDateOnly(item.eventDate || item.publishedAt), formatEventTimeOnly(item.eventDate, item.eventHasExplicitTime), eventVenueText(item)]
      .filter(Boolean)
      .join(" • ") || "Актуальная афиша Казани",
    variant === "compact" ? 28 : 44,
    2
  );
  const typeLabel = eventTypeLabel(item).toUpperCase();
  const titleFont = variant === "compact" ? 58 : 70;
  const metaY = 480 + Math.max(0, titleLines.length - 2) * 48;
  const titleNodes = titleLines
    .map((line, index) => `<text x="88" y="${242 + index * 78}" fill="#F8FAFC" font-size="${titleFont}" font-weight="680" font-family="'Segoe UI', 'SF Pro Text', Arial, sans-serif">${escapeSvgText(line)}</text>`)
    .join("");
  const metaNodes = metaLines
    .map((line, index) => `<text x="88" y="${metaY + index * 38}" fill="rgba(226,232,240,0.92)" font-size="28" font-weight="500" font-family="'Segoe UI', 'SF Pro Text', Arial, sans-serif">${escapeSvgText(line)}</text>`)
    .join("");

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" role="img" aria-label="${escapeSvgText(eventCardTitle(item) || "Событие")}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${palette.start}"/>
          <stop offset="55%" stop-color="${palette.mid}"/>
          <stop offset="100%" stop-color="${palette.end}"/>
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${palette.glow}"/>
          <stop offset="100%" stop-color="${palette.accent}"/>
        </linearGradient>
        <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="42"/>
        </filter>
      </defs>
      <rect width="1200" height="675" rx="34" fill="url(#bg)"/>
      <circle cx="1035" cy="126" r="210" fill="${palette.glow}" opacity="0.24" filter="url(#blur)"/>
      <circle cx="928" cy="548" r="240" fill="${palette.accent}" opacity="0.18" filter="url(#blur)"/>
      <rect x="72" y="64" width="320" height="42" rx="21" fill="rgba(9,18,31,0.28)" stroke="rgba(255,255,255,0.12)"/>
      <text x="96" y="92" fill="#D8F7E7" font-size="22" font-weight="700" letter-spacing="1.4" font-family="'Segoe UI', 'SF Pro Text', Arial, sans-serif">KAZAN EVENT RADAR</text>
      <rect x="72" y="132" width="${Math.max(180, 72 + typeLabel.length * 18)}" height="52" rx="26" fill="rgba(9,18,31,0.38)" stroke="rgba(255,255,255,0.12)"/>
      <text x="96" y="166" fill="${palette.badge}" font-size="28" font-weight="700" letter-spacing="1.1" font-family="'Segoe UI', 'SF Pro Text', Arial, sans-serif">${escapeSvgText(typeLabel)}</text>
      ${titleNodes}
      ${metaNodes}
      <rect x="72" y="563" width="366" height="54" rx="27" fill="rgba(9,18,31,0.4)" stroke="rgba(255,255,255,0.12)"/>
      <text x="96" y="598" fill="#F8FAFC" font-size="24" font-weight="600" font-family="'Segoe UI', 'SF Pro Text', Arial, sans-serif">Полная карточка события</text>
      <path d="M1020 102c0-16.569 13.431-30 30-30h52c16.569 0 30 13.431 30 30v52c0 16.569-13.431 30-30 30h-52c-16.569 0-30-13.431-30-30z" fill="rgba(9,18,31,0.28)" stroke="rgba(255,255,255,0.12)"/>
      <path d="M1048 148l24-24m0 0h-19m19 0v19" stroke="#F8FAFC" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `.trim();
}

function wrapPosterText(text, maxChars, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || !current) {
      current = next;
      continue;
    }

    lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }

  if (current && lines.length < maxLines) lines.push(current);
  const remaining = words.slice(lines.join(" ").split(/\s+/).filter(Boolean).length).join(" ").trim();
  if (remaining && lines.length) {
    lines[lines.length - 1] = trim(`${lines[lines.length - 1]} ${remaining}`, maxChars);
  }

  return lines.slice(0, maxLines);
}

function eventPosterPalette(kind) {
  return {
    concert: { start: "#0B1730", mid: "#173B77", end: "#0F2A4A", accent: "#6D7CFF", glow: "#2DD4BF", badge: "#C4FAE6" },
    theatre: { start: "#1A1127", mid: "#45205F", end: "#1B2C54", accent: "#F472B6", glow: "#A78BFA", badge: "#F7D6E9" },
    show: { start: "#0B172A", mid: "#0F4C81", end: "#13243F", accent: "#22D3EE", glow: "#60A5FA", badge: "#D5F4FF" },
    standup: { start: "#171124", mid: "#392363", end: "#1F2747", accent: "#F59E0B", glow: "#F97316", badge: "#FDE7BF" },
    exhibition: { start: "#102028", mid: "#1E4B59", end: "#132B38", accent: "#34D399", glow: "#38BDF8", badge: "#D5FBF0" },
    excursion: { start: "#0E1D24", mid: "#23555F", end: "#173646", accent: "#2DD4BF", glow: "#A3E635", badge: "#DCFCE7" },
    musical: { start: "#1A112B", mid: "#4C2C72", end: "#182A4A", accent: "#F472B6", glow: "#C084FC", badge: "#F5D9FF" },
    kids: { start: "#102038", mid: "#1D4ED8", end: "#0F3050", accent: "#F59E0B", glow: "#34D399", badge: "#FEF3C7" }
  }[kind] || { start: "#0B1730", mid: "#1D4ED8", end: "#0F2A4A", accent: "#60A5FA", glow: "#2DD4BF", badge: "#DCEBFF" };
}

function escapeSvgText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
    return { from, to: addDays(from, 3, to) };
  }

  if (rangeId === "week") {
    return { from, to: addDays(from, 7, to) };
  }

  return { from, to };
}

function isPresetActive(rangeId) {
  const preset = getPresetRange(rangeId);
  return preset.from === getEffectiveDateFrom() && preset.to === getEffectiveDateTo();
}

function addDays(dateString, days, maxDate) {
  const [year, month, day] = String(dateString)
    .split("-")
    .map((value) => Number(value));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const formatted = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
  if (!maxDate) return formatted;
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
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
