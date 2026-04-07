import { Markup } from "telegraf";
import { loadItems, scanSources } from "../aggregator.js";
import { isWithinDays } from "../lib/dates.js";
import { formatDigest } from "../lib/format.js";
import {
  CATALOG,
  MAIN_SECTIONS,
  getItem,
  getRoute,
  getRouteLevel,
  getRoutesByLevel,
  getSection,
  getSectionMeta
} from "../data/catalog.js";

export function registerMenu(bot) {
  bot.command("menu", showMainMenu);

  bot.action("menu:main", async (ctx) => {
    await answer(ctx);
    await showMainMenu(ctx);
  });

  bot.action(/^cat:(.+)$/, async (ctx) => {
    await answer(ctx);
    const sectionId = ctx.match[1];

    if (sectionId === "events") {
      await showEventsMenu(ctx);
      return;
    }

    if (sectionId === "routes") {
      await showRouteLevels(ctx);
      return;
    }

    await showSection(ctx, sectionId);
  });

  bot.action(/^item:([^:]+):(.+)$/, async (ctx) => {
    await answer(ctx);
    const [, sectionId, itemId] = ctx.match;
    const item = getItem(sectionId, itemId);

    if (!item) {
      await ctx.reply("Не нашел эту карточку. Вернитесь в меню и выберите пункт заново.", backToMainKeyboard());
      return;
    }

    await showItem(ctx, sectionId, item);
  });

  bot.action(/^routelevel:(.+)$/, async (ctx) => {
    await answer(ctx);
    await showRoutesByLevel(ctx, ctx.match[1]);
  });

  bot.action(/^route:(.+)$/, async (ctx) => {
    await answer(ctx);
    const route = getRoute(ctx.match[1]);

    if (!route) {
      await ctx.reply("Не нашел этот маршрут. Вернитесь в меню и выберите пункт заново.", backToMainKeyboard());
      return;
    }

    await showItem(ctx, "routes", route);
  });

  bot.action("events:today", async (ctx) => {
    await answer(ctx);
    const items = (await loadItems()).filter((item) => isWithinDays(item, 1));
    await ctx.reply(formatDigest(items, "Казань: мероприятия на сегодня"), eventsKeyboard());
  });

  bot.action("events:week", async (ctx) => {
    await answer(ctx);
    const items = (await loadItems()).filter((item) => isWithinDays(item, 7));
    await ctx.reply(formatDigest(items, "Казань: афиша на ближайшую неделю"), eventsKeyboard());
  });

  bot.action("events:scan", async (ctx) => {
    await answer(ctx);
    await ctx.reply("Обновляю источники афиши. Это может занять несколько секунд.");
    const items = await scanSources();
    await ctx.reply(`Готово. В базе сейчас ${items.length} материалов.`, eventsKeyboard());
  });
}

export async function showMainMenu(ctx) {
  const text = [
    "Главное меню Kazan Event Radar",
    "",
    "Выберите раздел: экскурсии, мероприятия, пешие маршруты, достопримечательности, отели, еда или парки.",
    "Внутри разделов будут вложенные кнопки и карточки с маршрутом."
  ].join("\n");

  await ctx.reply(text, mainKeyboard());
}

function mainKeyboard() {
  return Markup.inlineKeyboard(rows(
    MAIN_SECTIONS.map((section) => Markup.button.callback(section.label, `cat:${section.id}`)),
    2
  ));
}

async function showEventsMenu(ctx) {
  const text = [
    "Мероприятия",
    "",
    "Можно посмотреть афишу на сегодня, на ближайшую неделю или вручную обновить источники."
  ].join("\n");

  await ctx.reply(text, eventsKeyboard());
}

function eventsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Сегодня", "events:today"), Markup.button.callback("Неделя", "events:week")],
    [Markup.button.callback("Обновить афишу", "events:scan")],
    [Markup.button.callback("Назад в меню", "menu:main")]
  ]);
}

async function showRouteLevels(ctx) {
  const routes = CATALOG.routes;
  const buttons = routes.levels.map((level) => Markup.button.callback(level.title, `routelevel:${level.id}`));
  const text = [
    routes.title,
    "",
    routes.intro,
    "",
    ...routes.levels.map((level) => `${level.title}: ${level.description}`)
  ].join("\n");

  await ctx.reply(text, Markup.inlineKeyboard([
    ...rows(buttons, 1),
    [Markup.button.callback("Назад в меню", "menu:main")]
  ]));
}

async function showRoutesByLevel(ctx, levelId) {
  const level = getRouteLevel(levelId);
  const routes = getRoutesByLevel(levelId);

  if (!level || routes.length === 0) {
    await ctx.reply("Для этой сложности пока нет маршрутов.", backToMainKeyboard());
    return;
  }

  const text = [
    `Пешие маршруты: ${level.title}`,
    "",
    level.description,
    "",
    "Выберите маршрут:"
  ].join("\n");

  await ctx.reply(text, Markup.inlineKeyboard([
    ...routes.map((route) => [Markup.button.callback(`${route.title} · ${route.subtitle}`, `route:${route.id}`)]),
    [Markup.button.callback("Назад к сложности", "cat:routes"), Markup.button.callback("Главное меню", "menu:main")]
  ]));
}

async function showSection(ctx, sectionId) {
  const section = getSection(sectionId);
  const meta = getSectionMeta(sectionId);

  if (!section) {
    await ctx.reply("Такого раздела пока нет.", backToMainKeyboard());
    return;
  }

  const text = [
    section.title || meta?.label || "Раздел",
    "",
    section.intro || meta?.description || "Выберите пункт:"
  ].join("\n");

  await ctx.reply(text, Markup.inlineKeyboard([
    ...section.items.map((item) => [Markup.button.callback(buttonLabel(item), `item:${sectionId}:${item.id}`)]),
    [Markup.button.callback("Назад в меню", "menu:main")]
  ]));
}

async function showItem(ctx, sectionId, item) {
  const text = formatItem(item);
  const buttons = [];

  if (item.mapUrl) {
    buttons.push([Markup.button.url("Построить маршрут", item.mapUrl)]);
  }

  if (item.photoLinks?.length) {
    buttons.push(...rows(item.photoLinks.map((photo) => Markup.button.url(photo.label, photo.url)), 2));
  }

  if (item.sourceUrl) {
    buttons.push([Markup.button.url("Источник/подробнее", item.sourceUrl)]);
  }

  buttons.push(sectionId === "routes"
    ? [Markup.button.callback("К списку маршрутов", "cat:routes"), Markup.button.callback("Главное меню", "menu:main")]
    : [Markup.button.callback("К разделу", `cat:${sectionId}`), Markup.button.callback("Главное меню", "menu:main")]
  );

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

function formatItem(item) {
  const blocks = [
    `${item.title}${item.subtitle ? `\n${item.subtitle}` : ""}`,
    item.description,
    item.duration ? `Длительность: ${item.duration}` : null,
    item.highlights?.length ? `Что посмотреть:\n${item.highlights.map((value) => `- ${value}`).join("\n")}` : null,
    item.stops?.length ? `Маршрут:\n${item.stops.map((value, index) => `${index + 1}. ${value}`).join("\n")}` : null,
    item.foodNearby ? `Где перекусить рядом:\n${item.foodNearby}` : null,
    item.howToGet ? `Как добраться:\n${item.howToGet}` : null
  ].filter(Boolean);

  return blocks.join("\n\n");
}

function buttonLabel(item) {
  return item.subtitle ? `${item.title} · ${item.subtitle}` : item.title;
}

function backToMainKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("Главное меню", "menu:main")]]);
}

function rows(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

async function answer(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch {
    // Callback may already be answered; this should not block the menu.
  }
}
