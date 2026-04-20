# Автоматическое обновление разделов каталога

Этот контур отвечает за разделы:

- `места`
- `еда`
- `пешие маршруты`
- `активный отдых`
- `на машине`

## Что делает pipeline

1. Запускает все catalog import scripts
   или только те секции, которым уже пора обновиться по `refreshDays`
2. Пересобирает `src/data/catalog-imports.generated.js`
3. Прогоняет синтаксическую проверку проекта
4. По желанию деплоит Worker, чтобы обновления сразу появились в Mini App

## Локальные команды

- Только обновить каталог без деплоя:
  - `npm run catalog:refresh:local`
- Обновить только устаревшие секции:
  - `npm run catalog:refresh:stale`
- Обновить каталог и сразу задеплоить Worker:
  - `npm run catalog:refresh:pipeline`

## Отчёт

После каждого запуска сохраняется отчёт:

- `data/catalog-imports/refresh-report.json`

## GitHub Actions

Workflow:

- `.github/workflows/refresh-catalog.yml`

Расписание:

- каждый день, но workflow обновляет только устаревшие секции

Можно запускать и вручную через вкладку `Actions`.

## Какие секреты нужны

Для этого workflow достаточно двух секретов:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Если параллельно будете включать и workflow по афише, Base64 для auth state можно получить так:

```powershell
npm run github:secrets:auth
```

## Что обновляется в live-приложении

Worker отдаёт каталог через `/api/catalog`, поэтому после refresh и deploy новые карточки сразу начинают использоваться в Mini App без ручного редактирования фронтенда.
