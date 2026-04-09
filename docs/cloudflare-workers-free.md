# Бесплатный постоянный backend через Cloudflare Workers

Эта схема нужна, чтобы проект работал бесплатно и без включенного компьютера:

- Mini App frontend остается на GitHub Pages.
- API, Telegram webhook, напоминания, черновики и аналитика переезжают в Cloudflare Workers.
- Данные хранятся в Cloudflare KV.

## Что уже подготовлено в проекте

- `worker/src/index.js` - Cloudflare Worker API и Telegram webhook.
- `worker/wrangler.toml` - конфиг Worker и cron-задач.
- `worker/scripts/set-webhook.js` - установка Telegram webhook.
- `worker/scripts/set-miniapp-api.js` - запись URL Worker в Mini App frontend.

## Что нужно сделать один раз

1. Создать бесплатный аккаунт Cloudflare.
2. Открыть терминал в папке проекта:

```powershell
cd "C:\Users\User\Desktop\Все приложения\Documents\Playground\kazan-event-radar"
```

3. Войти в Cloudflare:

```powershell
npx wrangler login
```

4. Создать KV namespace:

```powershell
npx wrangler kv namespace create KAZAN_KV
npx wrangler kv namespace create KAZAN_KV --preview
```

5. Скопировать выданные `id` и `preview_id` в файл:

```text
worker/wrangler.toml
```

Нужно заменить:

```toml
id = "REPLACE_WITH_KV_NAMESPACE_ID"
preview_id = "REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID"
```

6. Сохранить секреты в Cloudflare:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ANALYTICS_PASSWORD
npx wrangler secret put ANALYTICS_SALT
```

Если `ANALYTICS_SALT` не хотите задавать вручную, можно использовать любую длинную случайную строку.

7. При необходимости добавить в `worker/wrangler.toml` обычные переменные:

- `TELEGRAM_MANAGER_CHAT_ID`, если уже знаете numeric id менеджера;
- `TELEGRAM_CHANNEL_ID`, если уже знаете numeric id канала;
- `MINI_APP_URL`, если Mini App URL изменится.

8. Развернуть Worker:

```powershell
npm run worker:deploy
```

После deploy появится URL вида:

```text
https://kazan-event-radar-api.<subdomain>.workers.dev
```

9. Привязать Telegram webhook:

```powershell
npm run worker:set-webhook -- https://kazan-event-radar-api.<subdomain>.workers.dev
```

10. Прописать этот backend URL в Mini App:

```powershell
npm run worker:set-miniapp-api -- https://kazan-event-radar-api.<subdomain>.workers.dev
```

11. Закоммитить и запушить обновленный `public/miniapp/config.js` в GitHub.

После этого GitHub Pages Mini App начнет ходить в Cloudflare Worker.

## Что получится в итоге

- Бот работает через webhook, а не через локальный `npm start`.
- Черновики для менеджера уходят автоматически каждый день.
- Напоминания отправляются по cron в Cloudflare.
- Аналитика доступна по backend URL:

```text
https://kazan-event-radar-api.<subdomain>.workers.dev/admin/analytics
```

- Mini App остается бесплатным и постоянным через GitHub Pages.

## Важное замечание

Локальный `npm start` после этого уже не обязателен для продакшена. Он остается только для локальной разработки и проверки.
