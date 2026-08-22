# Harzer Wandernadel – Route Matcher

A small, fully client-side web tool that compares a GPX route (e.g. exported from Komoot) against the coordinates of the 222 stamping points ("Stempelstellen") of the [Harzer Wandernadel](https://www.harzer-wandernadel.de) and shows which stamping points lie close to your route.

## What it does

1. You paste or upload a GPX file – e.g. a planned tour exported from Komoot.
2. The tool loads the reference coordinates of all Harzer Wandernadel stamping points once.
3. For every stamping point, it calculates the minimum distance to all points on your route (Haversine formula).
4. Every stamping point within an adjustable radius (default: 300 m) is shown as a match – sorted by distance, with a direct link to the location on Google Maps.

No server, no tracking, no data transfer: everything runs entirely in the user's browser.

## Usage

Just open `harzer-wandernadel-check.html` in a browser – no installation, no build step, no dependencies. The file can also be hosted directly via GitHub Pages (set `master` → `/ (root)` as the Pages source).

### Providing a GPX route
- **File upload:** via the "Upload .gpx file" button
- **Copy-paste:** paste the contents of the `.gpx` file directly into the text field

Tracks (`<trkpt>`), routes (`<rtept>`), and plain waypoint lists (`<wpt>`) are all supported – checked in that order, depending on which type is present in the file.

### Search radius
Adjustable via the slider between 50 m and 1000 m. Depending on the GPS accuracy of your route and the actual position of the stamp boxes, a wider radius (e.g. 300–500 m) may work better than a very tight one.

## Technical details

- **No frameworks:** a single, self-contained HTML file with embedded CSS/JS.
- **Reference data:** Last update 22.08.2026, loaded from official source [GPS download page of the Harzer Wandernadel](https://www.harzer-wandernadel.de/stempelstellen/gps-download/)
- **Distance calculation:** Haversine formula (great-circle distance), not path/trail routing.
- **Performance:** for very long tracks (> 3000 points), the route is evenly downsampled for the distance calculation to keep things smooth in the browser.

## Data source & accuracy

This project is not affiliated with Harzer Wandernadel GmbH.

⚠️ **Note:** The Harzer Wandernadel occasionally relocates individual stamping points. Some coordinates may therefore be slightly out of date. For the official, up-to-date GPS data, see the [GPS download page of the Harzer Wandernadel](https://www.harzer-wandernadel.de/stempelstellen/gps-download/).

## Known limitations

- Straight-line ("as the crow flies") distance instead of trail distance – a stamping point may appear "close" even if it's actually on the other side of a valley or cliff.
- No offline mode on the very first run (reference data has to be loaded once).
- No automatic cache refresh if the source data changes (the cache would need to be cleared manually from browser storage).

## License

Code: MIT. The stamping point coordinates are subject to the terms of use of Harzer Wandernadel GmbH (private, non-commercial use).