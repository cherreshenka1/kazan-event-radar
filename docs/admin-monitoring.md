# Admin Monitoring

Закрытая панель доступна по адресу:

```text
/admin/analytics
```

JSON-версия:

```text
/admin/analytics.json
```

Технический health-check:

```text
/health
```

## Что теперь показывает панель

- события аналитики и уникальных пользователей;
- свежесть афиши:
  - время последнего scan;
  - число событий в базе;
  - список источников;
  - статус последнего `events refresh`;
- свежесть каталога:
  - время последнего `catalog refresh`;
  - число секций;
  - число карточек;
  - сводку по разделам;
- последние действия пользователей в боте и Mini App.

## Откуда берутся данные

- аналитика:
  - KV key `analytics:events` в Worker;
  - локально: `data/analytics.json`;
- мета афиши:
  - KV key `events:meta`;
- системный отчёт по афише:
  - KV key `system:eventsRefreshReport`;
  - локально: `data/playwright/refresh-report.json`;
- системный отчёт по каталогу:
  - KV key `system:catalogRefreshReport`;
  - локально: `data/catalog-imports/refresh-report.json`.

## Как обновляются системные отчёты

После запуска:

```bash
node scripts/refresh-events-pipeline.mjs
node scripts/refresh-catalog-pipeline.mjs
```

отчёты:

1. сохраняются локально в `data/.../refresh-report.json`;
2. автоматически синхронизируются в Cloudflare KV;
3. сразу становятся видны в `/admin/analytics`.

## Когда это особенно полезно

- если кажется, что афиша давно не обновлялась;
- если нужно быстро понять, пустой ли источник или сломался refresh;
- если нужно проверить, сколько карточек реально живёт в каталоге после последнего обновления;
- если нужно посмотреть активность пользователей без захода в логи Worker;
- если нужен быстрый machine-readable статус через `/health`.
