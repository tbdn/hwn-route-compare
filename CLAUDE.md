# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A client-side web tool that compares GPX routes (e.g., from Komoot) against the 222 stamping points ("Stempelstellen") of the Harzer Wandernadel hiking badge system. Shows which stamping points lie within an adjustable radius of your route, with detour analysis and optional real trail distance calculation.

**Key characteristics:**
- No build step, no runtime dependencies - pure browser-based ES6 modules (npm is only used for the test tools)
- German-language UI
- Uses Haversine formula for great-circle distance calculations
- Routes with >3000 points are downsampled for performance
- GeoJSON as the internal data format
- Optional OpenRouteService integration for actual trail distances

## Running the Application

Requires a local server for ES modules to work:
```bash
npx serve src
# or
python -m http.server -d src
```

Then open http://localhost:3000 (or the port shown).

## Deployment (Portainer)

- `Dockerfile` (`nginx:alpine` + `docker/nginx.conf`) serves `src/`; `.dockerignore` keeps everything else out
- `scripts/package-portainer.sh` → `dist/hwn-route-compare-<date>.tar` (plain tar, Portainer "Build a new image → Upload"); `docker-compose.yml` is the stack, referencing the local image `hwn-route-compare:latest`. Steps: `docs/deploy-portainer.md`
- `docker/nginx.conf` must not use a `types {}` block (it would replace nginx's MIME table and serve ES modules as `application/octet-stream`); extra types go in `location` blocks via `default_type`

## Tests

```bash
npm install   # once: linkedom (DOM) and fake-indexeddb, dev dependencies only
npm test      # node --test tests/
```

- `tests/*.test.mjs` use the built-in `node:test` runner. Each file runs in its own process with a fresh app: `tests/helpers/browser.mjs` loads the real `src/index.html` into linkedom and stubs Leaflet, localStorage, downloads and `fetch` (files from `src/`, plus an OpenRouteService mock)
- Tests work with the real project data and derive expected values from it (e.g. "km offen" is recomputed), so refining tracks or tours should not break them
- linkedom does not reflect the `checked` attribute into the property: use `setChecked()` to change a checkbox and `isRenderedChecked()` to read a rendered one
- `package.json` sets `"type": "module"`; `scripts/package.json` keeps the Node scripts CommonJS

## Architecture

```
src/                        # Serve this directory
├── index.html              # Main HTML, loads Leaflet + app.js module
├── main.css                # All styles including map markers
├── app.js                  # Main application: UI handlers, rendering, orchestration
├── components/
│   ├── map.js              # Leaflet map: init, display route/stamps, pan/zoom
│   ├── tourplan.js         # "Tourenplan" tab: tour map, list, progress export/import, GPX tracks
│   └── stamppass.js        # "Meine Stempel" tab: all stamps, collected ones, toggle and list entry
├── data/
│   ├── stamps.geojson      # 222 HWN stamps as GeoJSON FeatureCollection
│   ├── tours.json          # Precomputed round tours (regions, stamp order, estimates)
│   ├── badges.json         # Badge levels (Bronze … Wanderkaiser, Steiger required stamps) and themed collections
│   └── tours/<ID>.gpx      # Optional real tracks per tour (e.g. Komoot), loaded automatically
└── utils/
    ├── geo.js              # Haversine distance, findNearbyStamps()
    ├── geojson.js          # GeoJSON conversion utilities
    ├── gpx.js              # GPX XML parsing: parseGPX(), gpxToGeoJSON()
    ├── stamps.js           # Loads stamps.geojson, converts to internal format
    ├── detour.js           # Exit point analysis, detour distance calculation
    ├── tracks.js           # Tour GPX tracks: project files + IndexedDB uploads, track stats
    ├── badges.js           # Badge progress from badges.json (levels, Steiger, collections, "seit" date)
    └── routing.js          # OpenRouteService API for real trail distances

data/
└── raw/HWN2025.gpx         # Official HWN GPX source file (input for conversion)

tests/                      # node --test (npm test), see "Tests"
├── helpers/browser.mjs     # linkedom DOM, Leaflet/fetch/ORS stubs, DOM helpers
└── *.test.mjs              # progress, part tours, own tours, group rest, Routenabgleich, storage/data

scripts/
├── convert-gpx-to-json.js  # Node.js script to regenerate src/data/stamps.geojson
└── suggest-tour-parts.js   # Splits long tours into two part tours (`parts` in tours.json, --write)
```

### Data Flow

1. User uploads/pastes GPX → `parseGPX()` extracts lat/lon coordinates
2. Stamps loaded from `stamps.geojson` via `loadStamps()` (GeoJSON → internal format)
3. `findNearbyStamps()` calculates minimum distance from each stamp to any route point
4. `analyzeDetours()` finds exit points and calculates detour distances
5. Results sorted by position along route, rendered as cards
6. Optional: User clicks "Route berechnen" → OpenRouteService calculates actual trail distance

### GeoJSON Format (stamps.geojson)

```javascript
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [10.58, 51.84, 555]  // [lon, lat, elevation]
      },
      "properties": {
        "id": "HWN001",
        "number": 1,
        "name": "Eckertalsperre",
        "description": "Eckertalsperre (Staumauer)"
      }
    }
  ]
}
```

### Internal Stamp Format (after conversion)

```javascript
{
    id: "HWN001",           // Display ID
    number: 1,              // Numeric for sorting
    name: "Eckertalsperre", // Short name
    description: "...",     // Full description
    lat: 51.841649,
    lon: 10.5799757,
    elevation: 555
}
```

## Regenerating Stamp Data

If the official HWN GPX data is updated, replace `data/raw/HWN2025.gpx` and run:
```bash
node scripts/convert-gpx-to-json.js
```

This outputs to `src/data/stamps.geojson`.

## API Integration (Optional)

The app supports OpenRouteService for calculating actual hiking trail distances:
- User provides their own API key (free tier: 2000 requests/day)
- Key stored in localStorage
- On-demand calculation via "🥾 Route berechnen" button
- All requests go to the GeoJSON endpoint (`requestRoute()` in `routing.js`), which returns plain `[lon, lat, ele]` coordinates; map functions get `[lat, lon]` arrays. (The JSON endpoint's encoded polyline carries a third value with `elevation: true`, which a 2D decoder garbles.)
- Results cached for 24 hours (`hwn-routing-cache-v2`; the old `hwn-routing-cache` with encoded polylines is removed)

## Route Extension

Users can select stamps and add them to the route:
- Checkbox on each stamp card for selection
- Hits that are already collected are marked ("✓ schon gestempelt" on the card, grey on the map, count in the header); `syncCollected()` in `app.js` follows `hwn:progress-changed`
- Floating selection bar shows count and "Zur Route hinzufügen" button
- Calculates actual hiking route via OpenRouteService API
- Modal shows total distance, duration, elevation gain/loss
- Extended route displayed on map as purple line with numbered stops
- GPX export for import back to Komoot or other navigation apps
- "Als eigene Tour speichern" in the modal hands the ORS track to the Tourenplan; the same button in the results header saves the compared route itself (stamps directly on the route and selected cards are preselected). `app.js` calls `openOwnTourDraft()` from `tourplan.js` after switching to the tab

## Matching suggestions (Routenabgleich)

- After every comparison, `#matchSection` lists every suggestion and part tour (whichever variant is chosen) with a stamp on the route (≤ 150 m), a stamp close to it (≤ `nearStampMeters` 300 m) or ≥ `sharedKm` 0.5 km of shared way; otherwise it says why nothing is there: `suggestionMatches({latLngs, km})` in `tourplan.js` (needs `loadStampProgress()` + `loadPlanTracks()`, which `runComparison()` awaits)
- Ways are compared with `trackOverlap()` in `tracks.js`: both tracks resampled every 20 m, a point counts as shared within `SAME_WAY_METERS` (60 m); shares are by length in both directions, stretches of the route ≥ 300 m off the suggestion are `deviations`
- Verdicts (`matchVerdict()`, `MATCH_RULES`): `fits` (all stamps, ≥ 80 % shared both ways; without a track: km within ±20 %), `covers` (route walks the whole suggestion and more), `inside` (route stays on it but skips a part), `differs` (same stamps, other ways), `partial` (some stamps), `nearby` (no stamp, but close or shared ways; missed stamps show their distance)
- "Auf Karte" draws the suggestion track dashed plus the route's deviations in orange (`displaySuggestion()` in `map.js`); the best match with a track is drawn right away. "Im Tourenplan" dispatches `hwn:show-tour`

## Meine Stempel (third tab, `#stempel`)

- Grid of all 222 stamps in number order (`stamppass.js`), collected ones filled; filter Alle/Offen/Gestempelt and search (digits = exact number, otherwise id/name/description)
- Ticking a tile or "Mehrere eintragen" (`parseNumbers()`: `3, 17 120-125`, `HWN020`) changes the same progress as the Tourenplan, with "Rückgängig" for the last list entry
- Progress stays owned by `tourplan.js`: `loadStampProgress()` loads tours.json and the progress without building the map, `setStampsCollected()` saves and redraws an open Tourenplan; `saveCollected()` dispatches `hwn:progress-changed`, which the stamp page syncs in place (focus stays, a stamp ticked under "Offen" stays visible until the filter changes)
- Badges: foldable box `#passBadges` (`<details>`, state in `hwn-badges-open`, the summary shows the next level) with the level ladder (from `badges.json` via `badgeProgress()` in `utils/badges.js`), ticks on the progress bar and the collections; select `#passTheme` filters the grid by a collection or the Steiger's required stamps. The Tourenplan shows the next level under "Stempel gesammelt" (`nextLevelHtml()`)
- The suggestion badge on a tile dispatches `hwn:show-tour` ({id}); `app.js` switches to the Tourenplan and calls `showTour()`. The "Stempel gesammelt" stat in the Tourenplan links to `#stempel`

## Tourenplan (second tab, `#touren`)

- Tours come from `src/data/tours.json`; stamp coordinates/names from `stamps.geojson`
- Tours in `tours.json` are **groups** ("Gruppe A1"): stamps that fit into one day, in a loop order. They are not routes: without a track the map shows the straight-line loop as a sketch. Routes come only from the user (Komoot): `src/data/tours/` holds Komoot tracks only, the Tourenplan has no OpenRouteService routing. Internal names (`suggestionUnits`, `suggestionMatches`, …) still say "suggestion"
- "In Komoot planen" (`#komootPlan`, also per part) and "Rest in Komoot planen" (`#restKomoot`) link to the Komoot planner via `komootPlanUrl(stamps)`: `komoot.com/de-de/plan/@lat,lon,13z?sport=hike&p[i][loc]=lat,lon&p[i][name]=…`, closed loop (first stamp repeated). Older ORS uploads in the browser are still labelled "Routenvorschlag (OpenRouteService, ungeprüft)"
- Collection dates live in `hwn-stamp-dates` (`{number: 'YYYY-MM-DD'}`, local date via `today()`); `collectStamps()` is the only place that collects/removes stamps (new stamps get the date, existing ones keep it). Export v4 adds `stampDates`; walked own tours carry `walkedAt`
- Progress is stored per stamp in localStorage (`hwn-stamps-collected`); a tour is done when all its stamps are collected. The tour checkbox sets/clears all of its stamps (indeterminate when partial), single stamps are toggled in the detail list. Legacy keys `hwn-tours-done` / `hwn-stamps-extra` are only read once for migration
- A track (planned or walked) never changes progress
- Season tags (ganzjährig/Apr–Nov/Mai–Okt) are computed from `tourFigures().maxEle` (`SEASON_TAGS`); `tours.json` `tags` only holds thematic hints
- Part tours: long tours have `parts` in `tours.json` (ids like `A5a`, own stamp order and estimate). They are "units" like tours (tracks `data/tours/A5a.gpx`, uploads, Komoot links keyed by part id). `defaultVariant: "parts"` in `tours.json` makes the parts the default (marked "empfohlen"); a browser choice (`whole`/`parts`) is stored in localStorage (`hwn-tour-variants`) only when it differs from the default, and exported as `variants`; map, region sums and "km/Hm offen/zurückgelegt" use the chosen variant (`shownUnits()`)
- `scripts/suggest-tour-parts.js` computes the splits (≥30 Leistungs-km, see thresholds in the script) and with `--write` updates `parts` in `tours.json`; existing parts of a tour without a track are kept (they were chosen with the former ORS tracks, the estimate is too short to judge them)
- Own tours ("+ Eigene Tour aus GPX"): records `{id: "own-<ts>", name, gpx, fileName, stamps, status: planned|walked, createdAt}` in IndexedDB store `own-tours` (DB version 2). Stamps are detected with `stampsAlongTrack()` (≤ `STAMP_ON_TRACK_METERS`, ordered along the track) and can be edited in the form. They are units with `own: true`, region `own`, listed in their own section; "Gelaufen" collects their stamps. Exported as `ownTours`; their Komoot links live in `hwn-komoot-links` under the own id
- "km/Hm zurückgelegt" = walked own tours + finished suggestions that share no stamp with a walked own tour
- Rest of a suggestion (`restStamps()` / `restFigures()`): stamps neither collected nor in a planned own tour (`plannedStampOwners()`), kept in the suggestion's order; unchanged → track/estimate figures, reduced → `estimateLoop()` (straight line × `ROUTE_FACTOR` 1.4), empty → 0. "km/Hm offen" = planned own tours + rest of open suggestions, so every open stamp counts once. List cells are refreshed in `render()` via `fillRowCells()`; reduced suggestions fade on the map with a dotted rest loop (`restLayer`)
- "Als eigene Tour übernehmen" (`adoptSuggestion`, only with a track) creates an own tour
- Track origin: `trackOrigin()` in `tracks.js` reads the GPX head (`ors` = OpenRouteService, `app` = straight lines from this app, `komoot`, `external`); `tracks` entries carry `origin`. "Verplant" (`stampPlanningMap()` / exported `stampPlanning()`) = open stamp passed by the Komoot/external track of an open unit (chosen variant or planned own tour); own tours with ORS/app tracks are "eigene Tour, ungeprüft". `ownTourStampOwners()` (rest of suggestions) ignores the origin so nothing counts twice. Project tracks load via `loadPlanTracks()` (tour plan or stamp page); `refreshTracks()` dispatches `hwn:progress-changed`
- Review hints ("⚠ prüfen", chip "Zu prüfen"): `computeReviews()` in `tourplan.js` judges only OpenRouteService tracks (`isSuggestedTrack`, now only older browser uploads) with `reviewTrack()` from `tracks.js` (detour legs, backtracking share) against `REVIEW_RULES`, plus `review: [text]` notes in `tours.json` and "parts much shorter than the whole". Recomputed whenever tracks change; finished tours and own tours are never flagged
- Chip "Geplant (n)" (`PLANNED_FILTER`, one of the `STATE_FILTERS` next to "Zu prüfen"): `isPlannedUnit()` = open unit of the chosen variant that is a planned own tour or has a Komoot/external track (`hasCheckedTrack`); rows, region cards, map and stamps are filtered, without a selection the detail lists the planned tours
- Plan for own tours, part tours and next steps: `docs/plan-eigene-touren.md`
- Plan for stamp dates, badges, backups and planned stamps on "Meine Stempel": `docs/plan-stempel.md`
- "Im Routenabgleich prüfen" dispatches `hwn:compare-route` ({gpx, name}) on `document`; `app.js` switches to the compare tab and runs the comparison
- Difficulty (`tourLevel()`) is computed in the app from `tourFigures()`: Leistungs-km = km + Hm/100; track thresholds 25/32, estimate thresholds 21/26.5 (+ ≥650 m → mittel), ≥850 m → anspruchsvoll. `tours.json` has no `level` field; `levelHtml()` shows the Leistungs-km (`.effort`, "~" when estimated) next to the level badge
- Komoot links: per tour `komoot: [{url, name}]` in `tours.json`, plus browser-added links in localStorage (`hwn-komoot-links`); both are shown
- Uploaded GPX tracks live in IndexedDB (`hwn-route-compare` / `tour-gpx`) and override `data/tours/<ID>.gpx`; "Browser-Tracks löschen (n)" next to export/import removes all of them at once (confirmation in the bar; own tours, Komoot links and progress stay) — useful after changing project files
- Backup bar `#backupBar` (export/import, uploads clear) sits outside the views and shows on "Meine Stempel" and in the Tourenplan; `loadPlanData()` already loads uploads and own tours, so exports are complete without the map. Reminder `#backupHint`: `hwn-last-backup`, `hwn-changes-since-backup`, `hwn-backup-snooze`; `navigator.storage.persist()` is requested once on the first collected stamp
- "Exportieren"/"Importieren" writes/reads a JSON backup (format `hwn-tourenplan-progress`; v2 added uploaded tracks and browser Komoot links, v3 makes `stamps` authoritative and keeps `doneTours` derived); import replaces browser state
