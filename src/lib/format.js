import { getItemDate } from "./dates.js";

export function formatDigest(items, title, limit = Number(process.env.MAX_ITEMS_PER_DIGEST || 12)) {
  const selected = items
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);

  if (selected.length === 0) {
    return `${title}\n\nПока ничего свежего не нашел. Добавьте источники в config/sources.json или запустите /scan позже.`;
  }

  const lines = selected.map((item, index) => {
    const date = getItemDate(item);
    const dateText = date ? ` · ${date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}` : "";
    const tags = item.categories?.length ? ` · ${item.categories.slice(0, 3).join(", ")}` : "";
    const summary = item.summary ? `\n${trim(item.summary, 220)}` : "";
    const url = item.url ? `\n${item.url}` : "";

    return `${index + 1}. ${item.title || "Без названия"}${dateText}${tags}${summary}${url}`;
  });

  return `${title}\n\n${lines.join("\n\n")}`;
}

function trim(text, maxLength) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
