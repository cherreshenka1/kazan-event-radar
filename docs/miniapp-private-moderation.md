# Закрытая модерация в Mini App

В Mini App появился приватный раздел `Модерация`. Обычные пользователи его не видят.

## Кто видит раздел

Доступ получает менеджер, заданный в переменных Worker:

- `TELEGRAM_MANAGER_CHAT_ID`
- `TELEGRAM_MANAGER_USERNAME`

Дополнительно можно допустить других людей:

- `MINIAPP_MODERATOR_IDS` — Telegram ID через запятую.
- `MINIAPP_MODERATOR_USERNAMES` — username без `@` или с `@`, тоже через запятую.

Пример:

```env
MINIAPP_MODERATOR_IDS=123456789,987654321
MINIAPP_MODERATOR_USERNAMES=helper_one,@helper_two
```

## Что видно внутри

Раздел показывает:

- состояние утренних черновиков для канала;
- сколько черновиков подготовлено сегодня;
- сколько сильных кандидатов есть для следующей пачки;
- разнообразие превью;
- свежесть афиши и каталога;
- команды для полуавтоматической модерации карточек;
- предупреждения системы, если что-то требует внимания.

## Как пользоваться карточками

1. Запустить сбор кандидатов:

```powershell
npm run catalog:moderation:candidates
```

2. Проверить `data/catalog-moderation/review-board.md`.
3. Выбрать фото в `data/catalog-moderation/photo-candidates`.
4. Скопировать approval-файл:

```powershell
Copy-Item data/catalog-moderation/approvals.template.json config/catalog-moderation-approvals.json
```

5. Поставить `approved: true` только у проверенных карточек.
6. Применить:

```powershell
npm run catalog:moderation:apply
```

Так я могу готовить черновики, а ты модерируешь только финальное качество.
