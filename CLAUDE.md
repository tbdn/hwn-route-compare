# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A client-side web tool that compares GPX routes (e.g., from Komoot) against the 222 stamping points ("Stempelstellen") of the Harzer Wandernadel hiking badge system. Shows which stamping points lie within an adjustable radius of your route, with detour analysis and optional real trail distance calculation.

**Key characteristics:**
- No build step, no npm dependencies - pure browser-based ES6 modules
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

## Architecture

```
src/                        # Serve this directory
├── index.html              # Main HTML, loads Leaflet + app.js module
├── main.css                # All styles including map markers
├── app.js                  # Main application: UI handlers, rendering, orchestration
├── components/
│   ├── map.js              # Leaflet map: init, display route/stamps, pan/zoom
│   └── tourplan.js         # "Tourenplan" tab: tour map, list, progress export/import, GPX tracks
├── data/
│   ├── stamps.geojson      # 222 HWN stamps as GeoJSON FeatureCollection
│   ├── tours.json          # Precomputed round tours (regions, stamp order, estimates)
│   └── tours/<ID>.gpx      # Optional real tracks per tour (e.g. Komoot), loaded automatically
└── utils/
    ├── geo.js              # Haversine distance, findNearbyStamps()
    ├── geojson.js          # GeoJSON conversion utilities
    ├── gpx.js              # GPX XML parsing: parseGPX(), gpxToGeoJSON()
    ├── stamps.js           # Loads stamps.geojson, converts to internal format
    ├── detour.js           # Exit point analysis, detour distance calculation
    ├── tracks.js           # Tour GPX tracks: project files + IndexedDB uploads, track stats
    └── routing.js          # OpenRouteService API for real trail distances

data/
└── raw/HWN2025.gpx         # Official HWN GPX source file (input for conversion)

scripts/
├── convert-gpx-to-json.js  # Node.js script to regenerate src/data/stamps.geojson
├── generate-tour-drafts.js # Placeholder GPX per tour and part tour → draft/tours/<ID>.gpx (straight-line loop + stamp waypoints)
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
- Floating selection bar shows count and "Zur Route hinzufügen" button
- Calculates actual hiking route via OpenRouteService API
- Modal shows total distance, duration, elevation gain/loss
- Extended route displayed on map as purple line with numbered stops
- GPX export for import back to Komoot or other navigation apps
- "Als eigene Tour speichern" in the modal hands the ORS track to the Tourenplan; the same button in the results header saves the compared route itself (stamps directly on the route and selected cards are preselected). `app.js` calls `openOwnTourDraft()` from `tourplan.js` after switching to the tab

## Tourenplan (second tab, `#touren`)

- Tours come from `src/data/tours.json`; stamp coordinates/names from `stamps.geojson`
- Tours in `tours.json` are suggestions ("Vorschlag A1"); ORS-computed tracks are labelled "Routenvorschlag (OpenRouteService, ungeprüft)"
- Progress is stored per stamp in localStorage (`hwn-stamps-collected`); a tour is done when all its stamps are collected. The tour checkbox sets/clears all of its stamps (indeterminate when partial), single stamps are toggled in the detail list. Legacy keys `hwn-tours-done` / `hwn-stamps-extra` are only read once for migration
- A track (planned or walked) never changes progress
- Season tags (ganzjährig/Apr–Nov/Mai–Okt) are computed from `tourFigures().maxEle` (`SEASON_TAGS`); `tours.json` `tags` only holds thematic hints
- Part tours: long tours have `parts` in `tours.json` (ids like `A5a`, own stamp order and estimate). They are "units" like tours (tracks `data/tours/A5a.gpx`, uploads, Komoot links keyed by part id). Per tour the variant whole/parts is stored in localStorage (`hwn-tour-variants`) and exported as `variants`; map, region sums and "km/Hm offen/zurückgelegt" use the chosen variant (`shownUnits()`)
- `scripts/suggest-tour-parts.js` computes the splits (≥30 Leistungs-km, see thresholds in the script) and with `--write` updates `parts` in `tours.json`; `generate-tour-drafts.js` also writes drafts for parts
- Own tours ("+ Eigene Tour aus GPX"): records `{id: "own-<ts>", name, gpx, fileName, stamps, status: planned|walked, createdAt}` in IndexedDB store `own-tours` (DB version 2). Stamps are detected with `stampsAlongTrack()` (≤ `STAMP_ON_TRACK_METERS`, ordered along the track) and can be edited in the form. They are units with `own: true`, region `own`, listed in their own section; "Gelaufen" collects their stamps. Exported as `ownTours`; their Komoot links live in `hwn-komoot-links` under the own id
- "km/Hm zurückgelegt" = walked own tours + finished suggestions that share no stamp with a walked own tour
- Rest of a suggestion (`restStamps()` / `restFigures()`): stamps neither collected nor in a planned own tour (`plannedStampOwners()`), kept in the suggestion's order; unchanged → track/estimate figures, reduced → `estimateLoop()` (straight line × `ROUTE_FACTOR` 1.4), empty → 0. "km/Hm offen" = planned own tours + rest of open suggestions, so every open stamp counts once. List cells are refreshed in `render()` via `fillRowCells()`; reduced suggestions fade on the map with a dotted rest loop (`restLayer`)
- "Rest auf Wanderwege legen" (`routeRest`) and "Als eigene Tour übernehmen" (`adoptSuggestion`, only with a track) create own tours
- Plan for own tours, part tours and next steps: `docs/plan-eigene-touren.md`
- "Auf Wanderwege legen" routes the closed stamp loop via ORS GeoJSON endpoint (`calculateHikingTrack`), converts it with `coordinatesToGPX` and stores it as an uploaded track
- "Im Routenabgleich prüfen" dispatches `hwn:compare-route` ({gpx, name}) on `document`; `app.js` switches to the compare tab and runs the comparison
- Difficulty (`tourLevel()`) is computed in the app from `tourFigures()`: Leistungs-km = km + Hm/100; track thresholds 25/32, estimate thresholds 21/26.5 (+ ≥650 m → mittel), ≥850 m → anspruchsvoll. `tours.json` has no `level` field
- Komoot links: per tour `komoot: [{url, name}]` in `tours.json`, plus browser-added links in localStorage (`hwn-komoot-links`); both are shown
- Uploaded GPX tracks live in IndexedDB (`hwn-route-compare` / `tour-gpx`) and override `data/tours/<ID>.gpx`
- "Exportieren"/"Importieren" writes/reads a JSON backup (format `hwn-tourenplan-progress`; v2 added uploaded tracks and browser Komoot links, v3 makes `stamps` authoritative and keeps `doneTours` derived); import replaces browser state
