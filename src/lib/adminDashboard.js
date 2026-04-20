export function renderAdminDashboard(summary = {}) {
  const system = summary.system || {};
  const eventMeta = system.eventMeta || null;
  const eventsRefresh = system.eventsRefresh || null;
  const catalogRefresh = system.catalogRefresh || null;
  const recentEvents = Array.isArray(summary.recentEvents) ? summary.recentEvents : [];
  const eventSources = Array.isArray(eventMeta?.sources) ? eventMeta.sources : [];
  const eventSteps = Array.isArray(eventsRefresh?.steps) ? eventsRefresh.steps : [];
  const catalogSections = Array.isArray(catalogRefresh?.sections) ? catalogRefresh.sections : [];
  const totalCatalogItems = catalogSections.reduce((sum, section) => sum + Number(section.itemCount || 0), 0);

  const recentRows = recentEvents.map((event) => `
    <tr>
      <td>${escapeHtml(formatDateTime(event.ts))}</td>
      <td>${escapeHtml(event.type || "-")}</td>
      <td>${escapeHtml(event.action || "-")}</td>
      <td>${escapeHtml(event.label || "")}</td>
      <td>${escapeHtml(event.source || "")}</td>
      <td>${escapeHtml(event.userHash || "")}</td>
    </tr>
  `).join("");

  const sourceRows = eventSources.length
    ? eventSources.map((source) => `
      <tr>
        <td>${escapeHtml(source.name || source.id || "-")}</td>
        <td>${escapeHtml(source.id || "-")}</td>
        <td>${escapeHtml(String(Number(source.importedItems || source.collectedItems || 0)))}</td>
        <td>${escapeHtml(String(Number(source.collectedLinks || 0)))}</td>
        <td>${escapeHtml(String(Number(source.queuedLinks || 0)))}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="5" class="muted">Источники ещё не синхронизированы.</td></tr>`;

  const eventStepRows = eventSteps.length
    ? eventSteps.map((step) => `
      <tr>
        <td>${escapeHtml(step.label || step.id || "-")}</td>
        <td>${renderStatusBadge(Boolean(step.ok), step.ok ? "OK" : "Ошибка")}</td>
        <td>${escapeHtml(formatDuration(step.durationMs))}</td>
        <td>${escapeHtml(formatDateTime(step.finishedAt))}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted">Отчёт refresh афиши ещё не загружен.</td></tr>`;

  const catalogRows = catalogSections.length
    ? catalogSections.map((section) => `
      <tr>
        <td>${escapeHtml(section.title || section.section || "-")}</td>
        <td>${escapeHtml(section.section || "-")}</td>
        <td>${escapeHtml(String(Number(section.itemCount || 0)))}</td>
        <td>${escapeHtml(formatDateTime(section.generatedAt))}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted">Отчёт refresh каталога ещё не загружен.</td></tr>`;

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kazan Event Radar Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #07111f;
        --panel: #0d1b2d;
        --panel-strong: #101f33;
        --line: rgba(255, 255, 255, 0.12);
        --text: #f8fafc;
        --muted: #9fb1c9;
        --accent: #60a5fa;
        --green: #86efac;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(circle at top, rgba(37, 99, 235, 0.18), transparent 28%), var(--bg);
        color: var(--text);
        font-family: Inter, Segoe UI, Arial, sans-serif;
      }
      main {
        width: min(1240px, 100%);
        margin: 0 auto;
        padding: 28px 16px 40px;
      }
      h1, h2, h3, p { margin: 0; }
      .hero {
        background: linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(17, 34, 64, 0.9));
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 24px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
      }
      .hero p {
        margin-top: 10px;
        color: var(--muted);
        max-width: 760px;
        line-height: 1.55;
      }
      .hero-meta {
        margin-top: 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .chip {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(96, 165, 250, 0.14);
        border: 1px solid rgba(96, 165, 250, 0.22);
        color: #dbeafe;
        font-size: 0.92rem;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
        margin-top: 18px;
      }
      .card, .panel, table {
        background: var(--panel-strong);
        border: 1px solid var(--line);
        border-radius: 20px;
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.18);
      }
      .card { padding: 18px; }
      .label {
        color: var(--muted);
        font-size: 0.94rem;
        margin-bottom: 10px;
      }
      .metric {
        font-size: 2rem;
        font-weight: 800;
        color: var(--green);
        line-height: 1.1;
      }
      .sub {
        margin-top: 8px;
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.45;
      }
      .section { margin-top: 18px; }
      .section-header {
        margin-bottom: 12px;
      }
      .section-header h2 {
        margin-bottom: 6px;
      }
      .section-header p {
        color: var(--muted);
        line-height: 1.5;
      }
      .panel { padding: 18px; }
      .panel-grid {
        display: grid;
        grid-template-columns: 1.1fr 1fr;
        gap: 14px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        overflow: hidden;
      }
      th, td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        vertical-align: top;
        font-size: 0.93rem;
      }
      th {
        color: #c7d8ef;
        font-weight: 700;
      }
      tr:last-child td { border-bottom: 0; }
      .muted { color: var(--muted); }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 0.82rem;
        font-weight: 700;
      }
      .status.ok {
        color: #dcfce7;
        background: rgba(34, 197, 94, 0.16);
        border: 1px solid rgba(34, 197, 94, 0.26);
      }
      .status.fail {
        color: #fee2e2;
        background: rgba(239, 68, 68, 0.14);
        border: 1px solid rgba(239, 68, 68, 0.24);
      }
      .key-value {
        display: grid;
        grid-template-columns: 170px 1fr;
        gap: 8px 12px;
        font-size: 0.94rem;
      }
      .key-value dt { color: var(--muted); }
      .key-value dd { margin: 0; }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        color: #dbeafe;
        font-size: 0.86rem;
        line-height: 1.45;
      }
      @media (max-width: 900px) {
        .panel-grid,
        .key-value {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>Kazan Event Radar Admin</h1>
        <p>Закрытая панель показывает не только клики и переходы, но и живое состояние базы событий, свежесть афиши и актуальность каталога мест. Это помогает быстро понять, всё ли обновляется как нужно.</p>
        <div class="hero-meta">
          <span class="chip">Обновлено: ${escapeHtml(formatDateTime(system.updatedAt || new Date().toISOString()))}</span>
          <span class="chip">Афиша: ${escapeHtml(formatRelative(eventMeta?.lastScanAt || eventsRefresh?.finishedAt))}</span>
          <span class="chip">Каталог: ${escapeHtml(formatRelative(catalogRefresh?.finishedAt))}</span>
        </div>
      </section>

      <section class="grid">
        <article class="card">
          <div class="label">Событий аналитики</div>
          <div class="metric">${escapeHtml(String(Number(summary.totalEvents || 0)))}</div>
          <div class="sub">Все записанные действия пользователей и служебные события.</div>
        </article>
        <article class="card">
          <div class="label">Уникальных пользователей</div>
          <div class="metric">${escapeHtml(String(Number(summary.uniqueUsers || 0)))}</div>
          <div class="sub">Оценка охвата по захешированным Telegram user id.</div>
        </article>
        <article class="card">
          <div class="label">Афиша в базе</div>
          <div class="metric">${escapeHtml(String(Number(eventMeta?.eventItems || eventMeta?.totalItems || 0)))}</div>
          <div class="sub">Последнее обновление: ${escapeHtml(formatDateTime(eventMeta?.lastScanAt || eventsRefresh?.finishedAt))}</div>
        </article>
        <article class="card">
          <div class="label">Карточек каталога</div>
          <div class="metric">${escapeHtml(String(Number(totalCatalogItems || 0)))}</div>
          <div class="sub">Секций: ${escapeHtml(String(catalogSections.length))}. Последнее обновление: ${escapeHtml(formatDateTime(catalogRefresh?.finishedAt))}</div>
        </article>
      </section>

      <section class="section">
        <div class="section-header">
          <h2>Состояние афиши</h2>
          <p>Здесь видно, когда в последний раз обновлялась база мероприятий, сколько источников участвует и как прошёл последний refresh.</p>
        </div>
        <div class="panel-grid">
          <article class="panel">
            <dl class="key-value">
              <dt>Последний scan</dt>
              <dd>${escapeHtml(formatDateTime(eventMeta?.lastScanAt || eventsRefresh?.finishedAt))}</dd>
              <dt>Причина</dt>
              <dd>${escapeHtml(eventMeta?.reason || eventsRefresh?.mode || "-")}</dd>
              <dt>Источников включено</dt>
              <dd>${escapeHtml(String(Number(eventMeta?.enabledSources || 0)))}</dd>
              <dt>Собрано ссылок/записей</dt>
              <dd>${escapeHtml(String(Number(eventMeta?.collectedItems || 0)))}</dd>
              <dt>Событий после фильтра</dt>
              <dd>${escapeHtml(String(Number(eventMeta?.eventItems || eventMeta?.totalItems || 0)))}</dd>
              <dt>Последний refresh</dt>
              <dd>${escapeHtml(formatRelative(eventsRefresh?.finishedAt))}</dd>
            </dl>
          </article>
          <article class="panel">
            <table>
              <thead>
                <tr>
                  <th>Шаг</th>
                  <th>Статус</th>
                  <th>Длительность</th>
                  <th>Завершён</th>
                </tr>
              </thead>
              <tbody>${eventStepRows}</tbody>
            </table>
          </article>
        </div>
      </section>

      <section class="section">
        <div class="section-header">
          <h2>Источники афиши</h2>
          <p>Короткая сводка по источникам из последней загруженной метаинформации.</p>
        </div>
        <article class="panel">
          <table>
            <thead>
              <tr>
                <th>Источник</th>
                <th>ID</th>
                <th>Импортировано</th>
                <th>Ссылок найдено</th>
                <th>В очереди</th>
              </tr>
            </thead>
            <tbody>${sourceRows}</tbody>
          </table>
        </article>
      </section>

      <section class="section">
        <div class="section-header">
          <h2>Состояние каталога</h2>
          <p>Контроль по разделам мини-приложения: места, еда, пешие маршруты, активный отдых и поездки на машине.</p>
        </div>
        <div class="panel-grid">
          <article class="panel">
            <dl class="key-value">
              <dt>Последний refresh</dt>
              <dd>${escapeHtml(formatDateTime(catalogRefresh?.finishedAt))}</dd>
              <dt>Режим stale-only</dt>
              <dd>${escapeHtml(catalogRefresh?.staleOnly ? "Да" : "Нет")}</dd>
              <dt>Деплой после refresh</dt>
              <dd>${escapeHtml(catalogRefresh?.deployRequested ? "Да" : "Нет")}</dd>
              <dt>Секций в каталоге</dt>
              <dd>${escapeHtml(String(catalogSections.length))}</dd>
              <dt>Карточек всего</dt>
              <dd>${escapeHtml(String(Number(totalCatalogItems || 0)))}</dd>
              <dt>Файл overrides</dt>
              <dd>${escapeHtml(catalogRefresh?.generatedOverrides?.file || "-")}</dd>
            </dl>
          </article>
          <article class="panel">
            <pre>${escapeHtml(JSON.stringify({
  byType: summary.byType || {},
  byAction: summary.byAction || {}
}, null, 2))}</pre>
          </article>
        </div>
      </section>

      <section class="section">
        <article class="panel">
          <table>
            <thead>
              <tr>
                <th>Раздел</th>
                <th>ID</th>
                <th>Карточек</th>
                <th>Сгенерирован</th>
              </tr>
            </thead>
            <tbody>${catalogRows}</tbody>
          </table>
        </article>
      </section>

      <section class="section">
        <div class="section-header">
          <h2>Последние действия пользователей</h2>
          <p>Свежая лента кликов, переходов и действий внутри мини-приложения и бота.</p>
        </div>
        <article class="panel">
          <table>
            <thead>
              <tr>
                <th>Время</th>
                <th>Тип</th>
                <th>Действие</th>
                <th>Метка</th>
                <th>Источник</th>
                <th>User hash</th>
              </tr>
            </thead>
            <tbody>${recentRows || `<tr><td colspan="6" class="muted">Событий аналитики пока нет.</td></tr>`}</tbody>
          </table>
        </article>
      </section>
    </main>
  </body>
</html>`;
}

function renderStatusBadge(ok, label) {
  return `<span class="status ${ok ? "ok" : "fail"}">${escapeHtml(label)}</span>`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatRelative(value) {
  if (!value) return "нет данных";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "нет данных";
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.round(diffMs / 60000);

  if (diffMinutes <= 1) return "только что";
  if (diffMinutes < 60) return `${diffMinutes} мин назад`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} ч назад`;

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} дн назад`;
}

function formatDuration(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "-";

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds} сек`;
  if (minutes < 60) return `${minutes} мин ${seconds} сек`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} ч ${restMinutes} мин`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
