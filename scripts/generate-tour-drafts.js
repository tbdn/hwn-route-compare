#!/usr/bin/env node
/**
 * Writes a placeholder GPX per tour to draft/tours/<ID>.gpx as a starting point for planning
 * (e.g. import into Komoot, snap to trails, export again as src/data/tours/<ID>.gpx).
 * Run: node scripts/generate-tour-drafts.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'src/data/tours.json'), 'utf-8'));
const geojson = JSON.parse(fs.readFileSync(path.join(root, 'src/data/stamps.geojson'), 'utf-8'));
const outDir = path.join(root, 'draft/tours');

const stamps = new Map(geojson.features.map(f => [f.properties.number, {
    id: f.properties.id,
    name: f.properties.name,
    description: f.properties.description,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    elevation: f.geometry.coordinates[2]
}]));
const regionName = code => plan.regions.find(r => r.code === code)?.name || code;

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

const ele = s => Number.isFinite(s.elevation) ? `<ele>${s.elevation}</ele>` : '';

function tourGpx(tour) {
    const tourStamps = tour.stamps.map(n => stamps.get(n)).filter(Boolean);
    const name = `HWN Tour ${tour.id} (Platzhalter)`;
    const desc = `${regionName(tour.region)} · Stempel ${tourStamps.map(s => s.id).join(', ')} · `
        + (tour.single
            ? 'Einzelstempel ohne Runde'
            : `Luftlinie, geschätzt ca. ${String(tour.km).replace('.', ',')} km / mind. ${tour.ascent} Hm`);

    const waypoints = tourStamps.map((s, i) => `
    <wpt lat="${s.lat}" lon="${s.lon}">
        ${ele(s)}
        <name>${escapeXml(`${i + 1}. ${s.id} ${s.name}`)}</name>
        <desc>${escapeXml(s.description || s.name)}</desc>
        <sym>Flag</sym>
    </wpt>`).join('');

    // Closed straight-line loop through the stamps; a single stamp has no track
    const loop = tour.single ? [] : [...tourStamps, tourStamps[0]];
    const track = loop.length ? `
    <trk>
        <name>${escapeXml(name)}</name>
        <desc>${escapeXml(desc)}</desc>
        <trkseg>${loop.map(s => `
            <trkpt lat="${s.lat}" lon="${s.lon}">${ele(s)}</trkpt>`).join('')}
        </trkseg>
    </trk>` : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="HWN Route Compare"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
    <metadata>
        <name>${escapeXml(name)}</name>
        <desc>${escapeXml(desc)}</desc>
    </metadata>${waypoints}${track}
</gpx>
`;
}

fs.mkdirSync(outDir, { recursive: true });
plan.tours.forEach(tour => fs.writeFileSync(path.join(outDir, `${tour.id}.gpx`), tourGpx(tour)));
console.log(`${plan.tours.length} Platzhalter-GPX nach ${path.relative(root, outDir)}/ geschrieben`);
