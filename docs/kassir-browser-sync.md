# Kassir Browser Sync

Kassir защищает страницы антиботом, поэтому для него используется чуть более надежная схема:

1. ссылки на события берутся из `https://kzn.kassir.ru/sitemap.xml`
2. карточки событий открываются в реальном браузере
3. после разовой проверки сохраняется локальная сессия
4. дальше можно собирать новые события автоматически

## Быстрый старт

Открыть Kassir в реальном браузере:

```powershell
npm run kassir:browser:open
```

После того как сайт открылся, пройди проверку или капчу вручную.

Потом сохрани сессию:

```powershell
npm run kassir:browser:state-save
```

После этого можно запускать сбор.

## Основные команды

Полный импорт всех доступных ссылок в разрешенном окне дат:

```powershell
npm run kassir:browser:sync -- --all
```

Ежедневное обновление только новых ссылок:

```powershell
npm run kassir:browser:incremental
```

Полная контрольная сверка источника:

```powershell
npm run kassir:browser:reconcile
```

Проверка без загрузки в API:

```powershell
npm run kassir:browser:sync -- --max-links=5 --no-upload
```

## Где лежат файлы

Сохраненная сессия Kassir:

```text
data/playwright/kassir-state.json
```

Собранные события:

```text
data/playwright/kassir-browser-events.json
```

Служебное состояние синка:

```text
data/playwright/kassir-browser-state.json
```

## Что важно понимать

Kassir не всегда дает стабильно читать карточки обычными запросами, поэтому схема с браузером для него безопаснее и надежнее, чем простой прямой парсинг.

Если снова увидишь сообщение про anti-bot, просто еще раз:

```powershell
npm run kassir:browser:open
npm run kassir:browser:state-save
```
