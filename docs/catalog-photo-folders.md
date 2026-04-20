# Catalog Photo Folders

Ниже список папок, куда можно докладывать локальные фотографии для карточек Mini App.

Формат файлов в каждой папке:

- `1.jpg`
- `2.jpg`
- `3.jpg`
- `4.jpg`

Как это работает теперь:

- `1.jpg` автоматически становится основной обложкой карточки
- `2.jpg`, `3.jpg` и `4.jpg` попадают в блок `Подборка фото`
- если локальных фото пока нет, Mini App покажет резервное изображение

## Base Path

- `public/miniapp/photos/`

## Sights

- `public/miniapp/photos/sights/kremlin/`
- `public/miniapp/photos/sights/kul_sharif/`
- `public/miniapp/photos/sights/bauman/`
- `public/miniapp/photos/sights/old_sloboda/`
- `public/miniapp/photos/sights/family_center/`
- `public/miniapp/photos/sights/farmers_palace/`

## Parks

- `public/miniapp/photos/parks/black_lake/`
- `public/miniapp/photos/parks/gorky/`
- `public/miniapp/photos/parks/uritsky/`
- `public/miniapp/photos/parks/victory/`
- `public/miniapp/photos/parks/gorkinsko_omet/`
- `public/miniapp/photos/parks/fuks/`

## Food

- `public/miniapp/photos/food/tugan_avylym/`
- `public/miniapp/photos/food/tatarskaya_usadba/`
- `public/miniapp/photos/food/chirem/`
- `public/miniapp/photos/food/gus/`
- `public/miniapp/photos/food/artel/`

## Hotels

- `public/miniapp/photos/hotels/nogai/`
- `public/miniapp/photos/hotels/kazan_palace/`
- `public/miniapp/photos/hotels/luciano/`
- `public/miniapp/photos/hotels/courtyard/`

## Excursions

- `public/miniapp/photos/excursions/classic/`
- `public/miniapp/photos/excursions/evening/`
- `public/miniapp/photos/excursions/old_tatar/`
- `public/miniapp/photos/excursions/food_walk/`

## Routes

- `public/miniapp/photos/routes/first_day/`
- `public/miniapp/photos/routes/old_tatar_kaban/`
- `public/miniapp/photos/routes/green_city/`
- `public/miniapp/photos/routes/kazanka_uram/`
- `public/miniapp/photos/routes/bauman_gorky/`

## Active

- `public/miniapp/photos/active/riviera/`
- `public/miniapp/photos/active/mazapark/`
- `public/miniapp/photos/active/thermal_beach/`
- `public/miniapp/photos/active/rope_park/`
- `public/miniapp/photos/active/uram/`
- `public/miniapp/photos/active/sup_kazanka/`

## Roadtrip

- `public/miniapp/photos/roadtrip/blue_lakes/`
- `public/miniapp/photos/roadtrip/sviyazhsk/`
- `public/miniapp/photos/roadtrip/innopolis/`
- `public/miniapp/photos/roadtrip/bulgar/`
- `public/miniapp/photos/roadtrip/raifa/`
- `public/miniapp/photos/roadtrip/kamskoye_ustye/`

## Обновление манифеста

После добавления новых локальных фотографий обновите манифест:

```powershell
npm run photos:manifest
```

После этого Mini App начнёт использовать новые фото автоматически.
