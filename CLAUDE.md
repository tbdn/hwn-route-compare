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
└── generate-tour-drafts.js # Placeholder GPX per tour → draft/tours/<ID>.gpx (straight-line loop + stamp waypoints)
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
- Results cached for 24 hours

## Route Extension

Users can select stamps and add them to the route:
- Checkbox on each stamp card for selection
- Floating selection bar shows count and "Zur Route hinzufügen" button
- Calculates actual hiking route via OpenRouteService API
- Modal shows total distance, duration, elevation gain/loss
- Extended route displayed on map as purple line with numbered stops
- GPX export for import back to Komoot or other navigation apps

## Tourenplan (second tab, `#touren`)

- Tours come from `src/data/tours.json`; stamp coordinates/names from `stamps.geojson`
- Progress (finished tours, extra stamps) lives only in localStorage (`hwn-tours-done`, `hwn-stamps-extra`)
- A track (planned or walked) never marks a tour as done; only the checkbox (list or detail) / progress import does
- "Im Routenabgleich prüfen" dispatches `hwn:compare-route` ({gpx, name}) on `document`; `app.js` switches to the compare tab and runs the comparison
- Komoot links: per tour `komoot: [{url, name}]` in `tours.json`, plus browser-added links in localStorage (`hwn-komoot-links`); both are shown
- Uploaded GPX tracks live in IndexedDB (`hwn-route-compare` / `tour-gpx`) and override `data/tours/<ID>.gpx`
- "Exportieren"/"Importieren" writes/reads a JSON backup (format `hwn-tourenplan-progress`, v2 includes uploaded tracks and browser Komoot links); import replaces browser state
