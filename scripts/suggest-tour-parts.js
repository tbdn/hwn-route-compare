#!/usr/bin/env node
/**
 * Suggests splitting long tours into two part tours and writes them as `parts` into src/data/tours.json.
 * A tour is a candidate from 30 "Leistungs-km" (km + Hm/100, from its GPX track when there is one).
 * The stamp order is cut into two consecutive groups, each walked as its own closed loop.
 * Run: node scripts/suggest-tour-parts.js            (prints the analysis)
 *      node scripts/suggest-tour-parts.js --write    (also updates tours.json)
 * Afterwards `node scripts/generate-tour-drafts.js` writes placeholder GPX files for the parts.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const toursPath = path.join(root, 'src/data/tours.json');
const plan = JSON.parse(fs.readFileSync(toursPath, 'utf-8'));
const geojson = JSON.parse(fs.readFileSync(path.join(root, 'src/data/stamps.geojson'), 'utf-8'));

const MIN_EFFORT = 30;          // Leistungs-km from which a tour is considered long
const MIN_PART_KM = 5;          // a shorter part is only fine when it lies in its own area ...
const SEPARATE_AREA_KM = 3;     // ... at least this far from the other part
const MAX_EXTRA_KM = 3;         // both parts together may be at most this much longer than the tour
const MAX_LONGER_SHARE = 0.75;  // the longer part has to be clearly shorter than the whole tour
const ROUTE_FACTOR = 1.4;       // straight line to path distance, as in tours.json
const ELEVATION_NOISE_METERS = 3;

// Tours that are long, but better handled differently
const NO_SPLIT = {
    B3: 'Brocken: besser als Streckenwanderung mit der Brockenbahn',
    C7: 'ein Teil wäre fast nur Hin- und Rückweg zum Goedeckenplatz, zusammen nur ~1,5 km kürzer',
    E1: 'mit Komoot als ganze Runde geplant'
};

const stamps = new Map(geojson.features.map(f => [f.properties.number, {
    number: f.properties.number,
    name: f.properties.name,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    elevation: f.geometry.coordinates[2]
}]));

function distanceKm(a, b) {
    const r = x => x * Math.PI / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2
        + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const round1 = n => Math.round(n * 10) / 10;

// Same estimate as the tours in tours.json: closed straight-line loop x 1.4, climbs between stamps
function estimate(group) {
    let km = 0;
    let ascent = 0;
    group.forEach((s, i) => {
        const next = group[(i + 1) % group.length];
        km += distanceKm(s, next);
        ascent += Math.max(0, next.elevation - s.elevation);
    });
    km *= ROUTE_FACTOR;
    const eles = group.map(s => s.elevation);
    return {
        km: round1(km),
        hours: round1(km / 4 + group.length * 0.1),
        ascent: Math.round(ascent),
        maxEle: Math.max(...eles),
        minEle: Math.min(...eles)
    };
}

// km and ascent of a project GPX track (same hysteresis as src/utils/tracks.js)
function trackFigures(id) {
    const file = path.join(root, 'src/data/tours', `${id}.gpx`);
    if (!fs.existsSync(file)) return null;
    const pts = [...fs.readFileSync(file, 'utf-8').matchAll(/<trkpt lat="([\d.-]+)" lon="([\d.-]+)"\s*>\s*(?:<ele>([\d.-]+)<\/ele>)?/g)]
        .map(m => ({ lat: +m[1], lon: +m[2], elevation: m[3] === undefined ? NaN : +m[3] }));
    if (pts.length < 2) return null;
    let km = 0;
    for (let i = 1; i < pts.length; i++) km += distanceKm(pts[i - 1], pts[i]);
    const eles = pts.map(p => p.elevation).filter(Number.isFinite);
    let ascent = 0;
    let ref = eles[0];
    for (const e of eles) {
        if (e - ref >= ELEVATION_NOISE_METERS) { ascent += e - ref; ref = e; }
        else if (ref - e >= ELEVATION_NOISE_METERS) ref = e;
    }
    return { km, ascent: eles.length ? ascent : null };
}

function gapKm(a, b) {
    return Math.min(...a.flatMap(x => b.map(y => distanceKm(x, y))));
}

function bestSplit(tour, factor) {
    const group = tour.stamps.map(n => stamps.get(n));
    const whole = estimate(group).km;
    let best = null;
    for (let start = 0; start < group.length; start++) {
        for (let len = 2; len <= group.length - 2; len++) {
            const a = Array.from({ length: len }, (_, k) => group[(start + k) % group.length]);
            const b = Array.from({ length: group.length - len }, (_, k) => group[(start + len + k) % group.length]);
            const [kmA, kmB] = [estimate(a).km * factor, estimate(b).km * factor];
            const extra = kmA + kmB - whole * factor;
            const score = Math.max(kmA, kmB) + 0.3 * extra;
            if (!best || score < best.score) best = { a, b, kmA, kmB, extra, score, gap: gapKm(a, b) };
        }
    }
    return best;
}

// Keep a name that was edited by hand as long as the part's stamps stay the same
function partName(group, previous) {
    const same = previous && previous.stamps.join() === group.map(s => s.number).join();
    return same && previous.name ? previous.name : `${group[0].name} – ${group[group.length - 1].name}`;
}

const results = {};
for (const tour of plan.tours.filter(t => !t.single)) {
    const est = estimate(tour.stamps.map(n => stamps.get(n)));
    const track = trackFigures(tour.id);
    // The existing parts were chosen with routed tracks; the straight-line estimate is too short to judge them again
    if (!track && tour.parts?.length) {
        console.log(`${tour.id}: ${est.km.toFixed(1)} km (geschätzt) → teilen: bestehende Teile behalten, ohne Track nicht neu bewertet`);
        results[tour.id] = tour.parts;
        continue;
    }
    const km = track?.km ?? est.km;
    const effort = km + (track?.ascent ?? est.ascent) / 100;
    if (effort < MIN_EFFORT) continue;

    const label = `${tour.id}: ${km.toFixed(1)} km, ${effort.toFixed(1)} Leistungs-km${track ? ' (Track)' : ' (geschätzt)'}`;
    if (NO_SPLIT[tour.id]) {
        console.log(`${label} → nicht teilen: ${NO_SPLIT[tour.id]}`);
        continue;
    }
    if (tour.stamps.length < 4) {
        console.log(`${label} → nicht teilbar: nur ${tour.stamps.length} Stempel`);
        continue;
    }

    // Track length relative to the estimate, to judge the parts on the same scale
    const factor = track ? track.km / est.km : 1;
    const split = bestSplit(tour, factor);
    const describe = g => g.map(s => s.number).join(', ');
    const summary = `[${describe(split.a)}] ~${split.kmA.toFixed(1)} km + [${describe(split.b)}] ~${split.kmB.toFixed(1)} km, `
        + `Mehrweg ${split.extra.toFixed(1)} km, Abstand ${split.gap.toFixed(1)} km`;

    const reasons = [];
    if (split.extra > MAX_EXTRA_KM) reasons.push(`Mehrweg über ${MAX_EXTRA_KM} km`);
    if (Math.max(split.kmA, split.kmB) > MAX_LONGER_SHARE * km) reasons.push('längerer Teil kaum kürzer als die Tour');
    if (Math.min(split.kmA, split.kmB) < MIN_PART_KM && split.gap < SEPARATE_AREA_KM) reasons.push(`ein Teil unter ${MIN_PART_KM} km, kein eigenes Gebiet`);

    if (reasons.length) {
        console.log(`${label} → nicht teilen (${reasons.join(', ')}): ${summary}`);
        continue;
    }
    console.log(`${label} → teilen: ${summary}`);
    const previous = tour.parts || [];
    results[tour.id] = [split.a, split.b].map((g, i) => ({
        id: `${tour.id}${'ab'[i]}`,
        name: partName(g, previous[i]),
        stamps: g.map(s => s.number),
        ...estimate(g)
    }));
}

if (process.argv.includes('--write')) {
    // tours.json keeps one tour per line, so only the affected lines change
    const lines = fs.readFileSync(toursPath, 'utf-8').split('\n').map(line => {
        const m = line.match(/^(\s*)(\{"id":"([^"]+)".*\})(,?)$/);
        if (!m || !plan.tours.some(t => t.id === m[3])) return line;
        const tour = JSON.parse(m[2]);
        if (results[tour.id]) tour.parts = results[tour.id];
        else delete tour.parts;
        return `${m[1]}${JSON.stringify(tour)}${m[4]}`;
    });
    fs.writeFileSync(toursPath, lines.join('\n'));
    console.log(`\n${Object.keys(results).length} Touren mit Teilvorschlägen in src/data/tours.json geschrieben: ${Object.keys(results).join(', ')}`);
} else {
    console.log('\nNur Analyse. Mit --write werden die Teilvorschläge in src/data/tours.json übernommen.');
}
