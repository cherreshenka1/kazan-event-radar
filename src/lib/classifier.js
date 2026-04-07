import { extractEventDate } from "./eventDates.js";

const CATEGORY_KEYWORDS = {
  events: ["афиша", "концерт", "выставка", "спектакль", "лекция", "маркет", "фестиваль", "вечеринка", "мастер-класс", "сегодня", "завтра", "выходные"],
  new_places: ["открыл", "открытие", "новое место", "новый ресторан", "новый бар", "запустил", "появил"],
  restaurants: ["ресторан", "завтрак", "ужин", "бранч", "кухня", "шеф", "меню", "кафе", "бистро"],
  bars: ["бар", "коктейль", "speakeasy", "секретный бар", "винная", "настойки"],
  viewpoints: ["панорама", "вид на", "смотровая", "крыша", "закат", "набережная", "колесо обозрения"],
  hidden: ["секрет", "неочевид", "скрыт", "двор", "тропа", "маршрут", "локальное место", "для своих"]
};

export function classifyItem(item) {
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  const scores = {};

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[category] = keywords.reduce((score, keyword) => (
      text.includes(keyword.toLowerCase()) ? score + 1 : score
    ), 0);
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
