import { loadTicketPlatforms } from "./config.js";

export async function attachTicketLinks(item) {
  return {
    ...item,
    ticketLinks: await buildTicketLinks(item)
  };
}

export async function buildTicketLinks(item) {
  const platforms = await loadTicketPlatforms();
  const query = encodeURIComponent(item.title || "Казань мероприятие");

  return platforms.map((platform) => ({
    id: platform.id,
    name: platform.name,
    url: (platform.searchUrl || platform.baseUrl || "").replace("{query}", query)
  })).filter((link) => link.url);
}
