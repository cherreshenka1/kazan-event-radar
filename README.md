# Kazan Event Radar

MVP Telegram-бота и Telegram Mini App, который собирает свежие мероприятия, места, рестораны, бары, панорамы и “секретные” локации Казани из настраиваемых источников.

## Что уже есть

- RSS-источники и HTML-страницы.
- Публичные Telegram-каналы через `https://t.me/s/<channel>`.
- Дедупликация ссылок и текстов.
- Простой скоринг по ключевым словам: мероприятия, новые места, рестораны, бары, панорамы, секретные места.
- Команды Telegram: `/start`, `/today`, `/week`, `/places`, `/secrets`, `/scan`.
- Фоновый сбор по расписанию из `SCAN_CRON`.
- Mini App: афиша, места, маршруты, избранное, напоминания и ссылки на билеты/источник.
- Согласование постов для Telegram-канала менеджером перед публикацией.

## Быстрый запуск

```bash
npm install
copy .env.example .env
npm run scan
npm start
```

В `.env` нужно добавить `TELEGRAM_BOT_TOKEN` от BotFather. Для Mini App локально используется `http://localhost:3000/miniapp/`, а для Telegram-продакшена нужен HTTPS URL.

Для канала добавьте:

- `TELEGRAM_CHANNEL_ID` - ID или username канала, где бот является администратором.
- `TELEGRAM_MANAGER_CHAT_ID` - chat id менеджера, который нажимает “Опубликовать” или “Отклонить”.
- `TELEGRAM_MANAGER_USERNAME` - username менеджера, если числовой chat id пока неизвестен.
- `TELEGRAM_CHANNEL_INVITE_URL` - invite link приватного канала, только как справочная ссылка; для публикации все равно нужен numeric channel id.
- `MINI_APP_URL` - публичный HTTPS URL Mini App после хостинга.

Если у вас есть только username менеджера и invite link канала:

1. Запишите `TELEGRAM_MANAGER_USERNAME`.
2. Менеджер должен открыть бота и отправить `/start` или `/id`.
3. Добавьте бота администратором канала с правом публикации.
4. Отправьте в канал `/channelid`.
5. Бот сохранит числовые ID в `data/runtime.json` и сможет отправлять черновики/публиковать посты.

По умолчанию бот каждый день в 09:00 по Москве отправляет менеджеру 10 черновиков. Менеджер публикует их вручную в нужное время. Количество задается `DRAFTS_PER_DAY`, расписание - `POST_APPROVAL_CRON`.

## Источники

Редактируйте `config/sources.json`. Для начала лучше подключить:

- сайты с афишей Казани, если у них есть RSS;
- публичные Telegram-каналы в формате `telegram_public_channel`;
- HTML-страницы с CSS-селекторами в формате `html`;
- социальные источники через легальные API/экспорт, не через передачу паролей в код.

Логины и пароли от Instagram/TikTok сюда не добавляйте. Если доступ понадобится, лучше использовать токены API или отдельный сервис-аккаунт с ограниченными правами и хранить токены только в `.env`.

## Документы

- `docs/miniapp-architecture.md` - структура Mini App, канала, напоминаний и билетов.
- `docs/source-access-checklist.md` - какие доступы нужны для Instagram, TikTok, Telegram, сайтов и билетных площадок.
- `docs/bot-profile.md` - тексты для профиля бота и визуальная концепция.
- `docs/deployment-https.md` - как получить публичный HTTPS URL для Telegram Mini App.
- `docs/social-accounts-setup.md` - как безопасно подготовить Instagram/TikTok/API.
- `docs/analytics.md` - закрытая аналитика и парольный доступ.
- `docs/github-pages-miniapp.md` - постоянная HTTPS-ссылка Mini App через GitHub Pages.

## Редактирование источников

Основной файл для новых источников:

```text
config/source-directory.json
```

Там можно добавлять Telegram-каналы, RSS, сайты, Instagram/TikTok API accounts и JSON-экспорты. Чтобы источник начал сканироваться, поставьте `enabled=true`.

Билетные площадки лежат в:

```text
config/ticket-platforms.json
```
