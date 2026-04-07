# Закрытая аналитика

Аналитика доступна по адресу:

```text
http://localhost:3000/admin/analytics
```

После деплоя:

```text
https://your-domain.example/admin/analytics
```

## Что отслеживается

- команды бота: `/start`, `/menu`, `/today`, `/week`, `/scan`, `/draft`;
- нажатия inline-кнопок в боте;
- просмотры Mini App;
- переключения вкладок Mini App;
- добавления/удаления избранного;
- создание напоминаний;
- переходы по внешним ссылкам и билетным площадкам.

Telegram не дает метрику “просмотры профиля бота” через Bot API, поэтому в MVP считаем реальные взаимодействия: `/start`, команды, кнопки и Mini App события.

## Как включить

Задайте пароль:

```powershell
npm run set-analytics-password
```

Или вручную в `.env`:

```env
ANALYTICS_USERNAME=admin
ANALYTICS_PASSWORD=strong-password
ANALYTICS_SALT=random-private-salt
```

`ANALYTICS_SALT` нужен, чтобы хэшировать Telegram user id в аналитике. Если не задан, будет использован bot token как salt.

## Данные

Сейчас события пишутся в:

```text
data/analytics.json
```

Для продакшена и роста пользователей следующий шаг - перенести аналитику в SQLite/PostgreSQL.
