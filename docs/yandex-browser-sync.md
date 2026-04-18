# Yandex Browser Sync

Этот сценарий собирает афишу Яндекс Афиши через реальный браузер и умеет работать в трех режимах:

- полный сбор
- ежедневное инкрементальное обновление
- контрольная полная сверка

## Что нужно заранее

1. Сохранить browser state:

```powershell
npm run browser -- state-save data/playwright/auth-state.json
```

2. Убедиться, что настроены:

- `ANALYTICS_PASSWORD`
- `public/miniapp/config.js` с `apiBaseUrl`

## Основные команды

Полный первый импорт:

```powershell
npm run yandex:browser:sync -- --all
```

Ежедневный легкий догон новых событий:

```powershell
npm run yandex:browser:incremental
```

Полная контрольная сверка с заменой слоя источника:

```powershell
npm run yandex:browser:reconcile
```

## Что делает state-файл

Скрипт хранит локальное состояние в:

```text
data/playwright/yandex-browser-state.json
```

Там сохраняются:

- уже увиденные ссылки
- время последнего обнаружения
- время успешной загрузки
- флаг `pendingUpload`, если карточка собрана, но еще не отправлена в worker

Это позволяет:

- не открывать каждый день одни и те же карточки
- не перегружать браузер
- не терять события, если загрузка в worker оборвалась

## Дополнительные флаги

Не отправлять в worker:

```powershell
npm run yandex:browser:sync -- --all --no-upload
```

Ограничить количество ссылок:

```powershell
npm run yandex:browser:sync -- --source=yandex-main --max-links=5 --no-upload
```

Явно указать state:

```powershell
npm run yandex:browser:sync -- --auth-state=data/playwright/auth-state.json
```

Явно указать браузер:

```powershell
npm run yandex:browser:sync -- --browser-path="C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
```
