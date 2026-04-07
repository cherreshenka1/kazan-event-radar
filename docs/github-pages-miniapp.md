# Постоянная ссылка Mini App через GitHub Pages

GitHub-репозиторий сам по себе не является сайтом, но GitHub Pages может бесплатно отдавать статический Mini App по HTTPS.

## Важный нюанс

GitHub Pages подходит только для frontend:

- интерфейс Mini App;
- страницы, стили, клиентский JavaScript;
- статические картинки.

Но серверные части не будут работать на GitHub Pages:

- Telegram bot process;
- сбор источников;
- напоминания;
- публикации в канал;
- закрытая аналитика;
- API `/api/events`, `/api/favorites`, `/admin/analytics`.

Поэтому правильная схема:

- Mini App frontend: GitHub Pages.
- Backend + bot: Render/Railway/Fly/VPS.

## Как будет выглядеть ссылка

Если GitHub username: `yourname`, repo: `kazan-event-radar`, то URL будет:

```text
https://yourname.github.io/kazan-event-radar/
```

Именно эту ссылку можно ставить в BotFather как Mini App URL.

## Что уже подготовлено

В проект добавлен GitHub Actions workflow:

```text
.github/workflows/deploy-miniapp.yml
```

Он публикует папку:

```text
public/miniapp
```

## Как включить GitHub Pages

1. Создайте GitHub repo `kazan-event-radar`.
2. Загрузите проект в repo.
3. В GitHub откройте repo settings.
4. Откройте `Pages`.
5. В `Build and deployment` выберите `GitHub Actions`.
6. Запустите workflow `Deploy Mini App to GitHub Pages`.

## Как подключить backend API

Когда backend будет развернут, например:

```text
https://kazan-event-radar.onrender.com
```

отредактируйте:

```text
public/miniapp/config.js
```

и поставьте:

```js
window.KAZAN_EVENT_RADAR_CONFIG = {
  apiBaseUrl: "https://kazan-event-radar.onrender.com"
};
```

Если `apiBaseUrl` пустой, Mini App пытается обращаться к API на том же домене, что работает локально и на Render, но не работает на GitHub Pages без отдельного backend URL.
