# Как получить публичный HTTPS URL для Mini App

Telegram Mini App не должен жить только на `localhost`: для реального использования нужен публичный HTTPS URL.

## Быстрый тест без деплоя

Для проверки можно временно открыть локальный сервер через туннель:

```powershell
npm start
ngrok http 3000
```

Ngrok выдаст ссылку вида:

```text
https://random-name.ngrok-free.app
```

Тогда Mini App URL будет:

```text
https://random-name.ngrok-free.app/miniapp/
```

Этот URL можно временно поставить в BotFather и в `.env` как `MINI_APP_URL`.

## Нормальный продакшен-вариант

Для продакшена лучше выбрать hosting, где Node.js процесс может работать постоянно:

- Render Web Service;
- Railway;
- Fly.io;
- VPS с Node.js и HTTPS через Nginx/Caddy;
- любой PaaS с long-running Node.js process.

Vercel/Netlify удобны для frontend, но текущий проект держит и бота, и scheduler в одном Node.js процессе. Поэтому для текущей архитектуры проще Render/Railway/Fly/VPS.

## Если Cloudflare/ngrok не работают

Попробуйте `localtunnel`, он обычно не требует регистрации:

```powershell
npx localtunnel --port 3000
```

Если он выдаст ссылку вида:

```text
https://example.loca.lt
```

Mini App URL будет:

```text
https://example.loca.lt/miniapp/
```

Это тоже временная ссылка для теста. Для продакшена лучше Render/Railway/Fly/VPS.

## Что задать на hosting

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Environment variables:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_MANAGER_USERNAME=cherreshenkaw
TELEGRAM_CHANNEL_INVITE_URL=https://t.me/+a0lYD_lfF584YmI6
MINI_APP_URL=https://your-domain.example/miniapp/
PORT=3000
ANALYTICS_USERNAME=admin
ANALYTICS_PASSWORD=strong-password
ALLOW_DEV_AUTH=false
```

После деплоя:

1. Откройте `https://your-domain.example/health`.
2. Проверьте `https://your-domain.example/miniapp/`.
3. В BotFather откройте настройки Mini App/Web App и укажите `https://your-domain.example/miniapp/`.
4. В `.env` или env vars hosting задайте тот же URL как `MINI_APP_URL`.

## Что важно

- URL должен быть HTTPS.
- Для Mini App auth в продакшене поставьте `ALLOW_DEV_AUTH=false`.
- Для аналитики обязательно задайте `ANALYTICS_PASSWORD`.
- Если hosting перезапускается и локальная папка `data/` очищается, нужно перейти с JSON-файлов на SQLite/PostgreSQL.
