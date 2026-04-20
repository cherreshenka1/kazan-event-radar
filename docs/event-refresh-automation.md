# Автоматическое обновление афиши

Этот контур обновляет базу событий автоматически и не трогает канал, черновики и автопостинг.

## Что обновляется

- Yandex Afisha
- MTS Live
- Kassir
- официальный спорт

## Локальные команды

- Инкрементальное обновление:
  - `npm run events:refresh`
- Полное обновление:
  - `npm run events:refresh:full`

После каждого запуска создаётся отчёт:

- `data/playwright/refresh-report.json`

## GitHub Actions

Workflow:

- `.github/workflows/refresh-events.yml`

Расписание:

- каждый день: инкрементальное обновление
- каждый понедельник: полное обновление

Также workflow можно запускать вручную через вкладку `Actions`.

## Какие GitHub Secrets нужны

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `YANDEX_AUTH_STATE_B64`
- `KASSIR_AUTH_STATE_B64`

## Как подготовить auth state для браузерных источников

1. Убедись, что локально актуальны файлы:
   - `data/playwright/yandex-state.json`
   - `data/playwright/kassir-state.json`
2. Переведи каждый файл в Base64.
3. Сохрани строки в GitHub Secrets:
   - `YANDEX_AUTH_STATE_B64`
   - `KASSIR_AUTH_STATE_B64`

Примеры для PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("data/playwright/yandex-state.json"))
[Convert]::ToBase64String([IO.File]::ReadAllBytes("data/playwright/kassir-state.json"))
```

Или одной командой:

```powershell
npm run github:secrets:auth
```

## Как используются данные Cloudflare

На GitHub runner во время workflow автоматически создаётся файл `.cloudflare.env` из двух секретов:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

В репозиторий эти значения не сохраняются.

## Что можно посмотреть после запуска

Workflow загружает артефакты:

- отчёт по обновлению
- актуальные snapshots по каждому импортёру
