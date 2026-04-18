# Playwright для браузерной авторизации

Ниже самый простой сценарий, чтобы я мог дальше работать через реальный браузер, а от тебя нужен был только вход в аккаунт.

Важно:

- `npm run browser -- ...` нужен для ручного открытия сайта и сохранения авторизации
- сам сбор событий Яндекс Афиши теперь делает отдельный скрипт `npm run yandex:browser:sync`
- то есть `browser` и `yandex:browser:sync` теперь выполняют разные роли

## Что уже подготовлено

В проект добавлена команда:

```powershell
npm run browser -- ...
```

Она запускает `playwright-cli` через `npx`, поэтому отдельная ручная установка обычно не нужна.

По умолчанию используется одна и та же сессия браузера `kazan-event-radar`, поэтому команды `open`, `snapshot`, `click`, `state-save` и другие будут работать в одном контексте.

## Как запускать

Открой PowerShell в папке проекта:

```powershell
C:\Users\User\Desktop\Все приложения\Documents\Playground\kazan-event-radar
```

Проверь, что команда видна:

```powershell
npm run browser -- --help
```

Если нужно открыть сайт в обычном окне браузера:

```powershell
npm run browser -- open https://afisha.yandex.ru/kazan --headed
```

Если нужно открыть MTS Live:

```powershell
npm run browser -- open https://live.mts.ru/kazan --headed
```

## Как сохранить авторизацию

После того как ты вошёл в аккаунт в открывшемся окне браузера, можно сохранить состояние:

```powershell
npm run browser -- state-save data/playwright/yandex-state.json
```

Потом я смогу использовать эту авторизацию снова:

```powershell
npm run browser -- state-load data/playwright/yandex-state.json
```

Аналогично можно сделать отдельный файл для MTS Live:

```powershell
npm run browser -- state-save data/playwright/mts-state.json
```

## Как будем работать дальше

1. Я говорю, какой сайт открыть.
2. Ты запускаешь команду.
3. Откроется окно браузера.
4. Ты входишь в аккаунт вручную.
5. Пишешь мне `готово`.
6. При необходимости сохраняем состояние через `state-save`.
7. Я продолжаю работу уже с этим браузером и сценарием.

## Как потом запустить сборщик Яндекс Афиши

После того как авторизация сохранена, сам импорт событий запускается отдельно:

```powershell
npm run yandex:browser:sync
```

Если нужно только проверить локально и не загружать данные в API:

```powershell
npm run yandex:browser:sync -- --no-upload
```

## Если система спросит разрешение

При первом запуске `npx` может скачать пакет `@playwright/cli`.

Это нормально.

Если Windows или терминал спрашивает подтверждение, можно разрешить запуск.

## Если браузер не открылся

Проверь:

```powershell
node --version
npm --version
```

Потом снова выполни:

```powershell
npm run browser -- --help
```

Если появится ошибка, просто пришли мне её текст, и я подправлю всё дальше сам.
