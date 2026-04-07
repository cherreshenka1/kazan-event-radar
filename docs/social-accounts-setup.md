# Как подготовить Instagram и TikTok для сбора данных

Пароли от личных аккаунтов не нужны и небезопасны. Нормальный путь - официальные API, OAuth и отдельные сервисные аккаунты.

## Instagram

Лучший вариант для легального доступа: Instagram API через Meta.

Что сделать:

1. Создать отдельный Instagram Business или Creator аккаунт для проекта.
2. Создать Facebook Page для проекта.
3. Связать Instagram аккаунт с Facebook Page.
4. Создать Meta Developer account.
5. Создать Meta App.
6. Настроить Instagram API / Facebook Login flow.
7. Получить access token через OAuth.
8. Сохранить token только в `.env`, например:

```env
INSTAGRAM_ACCESS_TOKEN=...
INSTAGRAM_ACCOUNT_ID=...
```

Что понадобится от вас:

- email/телефон для сервисного Instagram аккаунта;
- доступ к Facebook Page;
- Meta Developer account;
- список Instagram аккаунтов, которые разрешено мониторить;
- понимание: мы читаем только то, что API разрешает читать, без обхода закрытых профилей.

## TikTok

Лучший вариант: TikTok for Developers + Login Kit / Display API.

Что сделать:

1. Создать отдельный TikTok аккаунт для проекта.
2. Создать TikTok Developer account.
3. Создать app в TikTok Developer Portal.
4. Настроить Login Kit.
5. Запросить нужные scopes, минимум:

```text
user.info.basic
video.list
```

6. Пройти app review, если TikTok потребует review для доступа.
7. Получить OAuth access token.
8. Сохранить token только в `.env`, например:

```env
TIKTOK_ACCESS_TOKEN=...
```

Что понадобится от вас:

- email/телефон для сервисного TikTok аккаунта;
- TikTok Developer account;
- список TikTok аккаунтов/авторов, которые разрешено мониторить;
- понимание: API `video.list` возвращает публичные видео авторизованного пользователя, а не произвольное скрытое содержимое чужих аккаунтов.

## Telegram

Публичные каналы:

- добавьте username канала в `config/source-directory.json`;
- поставьте `enabled=true`, если канал проверен.

Приватный канал для публикаций:

- добавьте бота админом;
- отправьте в канал `/channelid`;
- бот сохранит numeric channel id в `data/runtime.json`.

## Сайты и статьи

Для сайта лучше сначала искать:

- RSS;
- sitemap;
- страницу афиши;
- страницу статей;
- CSS-селекторы карточек.

Новый сайт можно добавить в `config/source-directory.json` в блок `webPages`.
