import { analyticsStore } from "../storage/analyticsStore.js";

export function registerAdminRoutes(app) {
  app.get("/admin/analytics", requireAdminAuth, async (_req, res) => {
    const summary = await analyticsStore.summary();
    res.type("html").send(renderAnalyticsPage(summary));
  });

  app.get("/admin/analytics.json", requireAdminAuth, async (_req, res) => {
    res.json(await analyticsStore.summary());
  });
}

export function requireAdminAuth(req, res, next) {
  const expectedUser = process.env.ANALYTICS_USERNAME || "admin";
  const expectedPassword = process.env.ANALYTICS_PASSWORD;

  if (!expectedPassword) {
    return res.status(503).send("ANALYTICS_PASSWORD is not configured.");
  }

  const header = req.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    return requestAuth(res);
  }

  const [user, password] = Buffer.from(encoded, "base64").toString("utf8").split(":");

  if (user !== expectedUser || password !== expectedPassword) {
    return requestAuth(res);
  }

  return next();
}

function requestAuth(res) {
  res.set("WWW-Authenticate", "Basic realm=\"Kazan Event Radar Analytics\"");
  return res.status(401).send("Authentication required.");
}

function renderAnalyticsPage(summary) {
  const recent = summary.recentEvents.map((event) => `
    <tr>
      <td>${escapeHtml(new Date(event.ts).toLocaleString("ru-RU"))}</td>
      <td>${escapeHtml(event.type)}</td>
      <td>${escapeHtml(event.action)}</td>
      <td>${escapeHtml(event.label || "")}</td>
      <td>${escapeHtml(event.source || "")}</td>
      <td>${escapeHtml(event.userHash || "")}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kazan Event Radar Analytics</title>
    <style>
      body { margin: 0; font-family: Inter, Segoe UI, sans-serif; background: #07111f; color: #f8fafc; }
      main { width: min(1120px, 100%); margin: 0 auto; padding: 28px 16px; }
      h1 { margin: 0 0 18px; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 18px 0; }
      .card, table { border: 1px solid rgba(255,255,255,.12); border-radius: 18px; background: #101f33; box-shadow: 0 12px 30px rgba(0,0,0,.18); }
      .card { padding: 18px; }
      .metric { font-size: 2.2rem; font-weight: 800; color: #86efac; }
      table { width: 100%; border-collapse: collapse; overflow: hidden; }
      th, td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.08); text-align: left; font-size: .92rem; vertical-align: top; }
      th { color: #bbf7d0; }
      pre { white-space: pre-wrap; word-break: break-word; color: #dbeafe; }
    </style>
  </head>
  <body>
    <main>
      <h1>Kazan Event Radar Analytics</h1>
      <div class="cards">
        <section class="card"><div>Всего событий</div><div class="metric">${summary.totalEvents}</div></section>
        <section class="card"><div>Уникальных пользователей</div><div class="metric">${summary.uniqueUsers}</div></section>
        <section class="card"><div>По типам</div><pre>${escapeHtml(JSON.stringify(summary.byType, null, 2))}</pre></section>
        <section class="card"><div>По действиям</div><pre>${escapeHtml(JSON.stringify(summary.byAction, null, 2))}</pre></section>
      </div>
      <h2>Последние события</h2>
      <table>
        <thead><tr><th>Время</th><th>Тип</th><th>Действие</th><th>Метка</th><th>Источник</th><th>User hash</th></tr></thead>
        <tbody>${recent}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
