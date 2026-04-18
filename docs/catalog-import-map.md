# Catalog Import Map

This document fixes the practical file layout for the non-event sections of Kazan Event Radar.

## Current Source Of Truth

- `src/data/catalog.js`
Current manual catalog for:
- sights
- parks
- food
- hotels
- excursions
- routes
- active
- roadtrip

- `public/miniapp/app.js`
  UI rendering for all catalog sections and favorites.

- `worker/src/index.js`
  API layer that returns `CATALOG` to the Mini App through `/api/catalog`.

## New Import Control File

- `config/catalog-sources.json`
  Main registry for all non-afisha sources.

It defines:
- section label
- refresh cadence
- raw import directory
- normalized output file
- photo directory
- card fields
- source list per section

## Data Layout

- `data/catalog-imports/raw/<section>/`
  Raw downloaded payloads, html snapshots, json responses, or parser outputs.

- `data/catalog-imports/normalized/<section>.json`
  Clean normalized records ready to be merged into `src/data/catalog.js` or served directly by API later.

## Recommended Migration Path

### Step 1
Keep `src/data/catalog.js` as the active source of truth for the Mini App.

### Step 2
Start importing section data into:
- `data/catalog-imports/raw/`
- `data/catalog-imports/normalized/`

### Step 3
Add one loader layer that can read normalized files first, and fall back to `src/data/catalog.js` when imports are missing.

### Step 4
After validation, move individual sections from hardcoded catalog to import-driven catalog.

## Current Status

Already implemented:

- `sights`
  - importer: `scripts/import-sights-catalog.mjs`
  - manifest: `config/catalog-sights-items.json`
  - runtime override: active

- `parks`
  - importer: `scripts/import-parks-catalog.mjs`
  - manifest: `config/catalog-parks-items.json`
  - runtime override: active

- `food`
  - importer: `scripts/import-food-catalog.mjs`
  - manifest: `config/catalog-food-items.json`
  - runtime override: active

- `hotels`
  - importer: `scripts/import-hotels-catalog.mjs`
  - manifest: `config/catalog-hotels-items.json`
  - runtime override: active

- `excursions`
  - importer: `scripts/import-excursions-catalog.mjs`
  - manifest: `config/catalog-excursions-items.json`
  - runtime override: active

- `routes`
  - importer: `scripts/import-routes-catalog.mjs`
  - manifest: `config/catalog-routes-items.json`
  - runtime override: active

- `active`
  - importer: `scripts/import-active-catalog.mjs`
  - manifest: `config/catalog-active-items.json`
  - runtime override: active

- `roadtrip`
  - importer: `scripts/import-roadtrip-catalog.mjs`
  - manifest: `config/catalog-roadtrip-items.json`
  - runtime override: active

Current generated runtime bridge:

- `src/data/catalog-imports.generated.js`

Current helper scripts:

- `npm run catalog:food`
- `npm run catalog:sights`
- `npm run catalog:parks`
- `npm run catalog:hotels`
- `npm run catalog:excursions`
- `npm run catalog:routes`
- `npm run catalog:active`
- `npm run catalog:roadtrip`
- `npm run catalog:refresh`
- `npm run catalog:build`
- `npm run catalog:sources`

## Best Order Of Implementation

1. `food`
2. `hotels`
3. `active`
4. `roadtrip`
5. `sights`
6. `parks`
7. `excursions`
8. `routes`

## Parsing Rules

- Official sites have higher priority than maps and aggregators.
- Maps are used for:
  - route
  - address
  - opening hours
  - rating
  - review count
  - photos
- Aggregators are used for:
  - booking
  - price
  - comparison
- Card text must always be short and paraphrased.
- Reviews must be summarized, never copied in bulk.

## Practical Next Scripts

When we move from planning to implementation, the next useful scripts will be:

- `scripts/import-food-catalog.mjs`
- `scripts/import-sights-catalog.mjs`
- `scripts/import-parks-catalog.mjs`
- `scripts/import-active-catalog.mjs`
- `scripts/import-roadtrip-catalog.mjs`
- `scripts/import-hotels-catalog.mjs`
- `scripts/import-excursions-catalog.mjs`
- `scripts/import-routes-catalog.mjs`

Each should:
- read source definitions from `config/catalog-sources.json`
- save raw payloads into `data/catalog-imports/raw/<section>/`
- build normalized output into `data/catalog-imports/normalized/<section>.json`

## Validation

- `npm run catalog:sources`
  Checks the structure of `config/catalog-sources.json` and prints a short summary.
