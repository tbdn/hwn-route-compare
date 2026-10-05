// Tourenplan: suggested round tours ("Vorschläge") covering all stamps, grouped by region.
// Has its own Leaflet map so it doesn't interfere with the route comparison map.
// Tours can carry a real GPX track (project file or browser upload) that replaces the straight-line loop.
// Progress is stored per stamp; a tour counts as done when all of its stamps are collected.
// Long tours can have two part tours ("parts" in tours.json); each tour is shown either whole or in parts.

import { generateGPX, downloadGPX } from "../utils/optimize.js";
import {
    analyzeTrack, loadProjectTracks, loadUploadedTracks, saveUploadedTrack,
    deleteUploadedTrack, clearUploadedTracks, coordinatesToGPX, STAMP_ON_TRACK_METERS
} from "../utils/tracks.js";
import { calculateHikingTrack, hasApiKey } from "../utils/routing.js";
import { distanceMeters } from "../utils/geo.js";

const HARZ_CENTER = [51.72, 10.75];
const COLLECTED_STORAGE = 'hwn-stamps-collected';
// Tour-based progress before format v3, only read once for the migration
const LEGACY_DONE_STORAGE = 'hwn-tours-done';
const LEGACY_EXTRA_STORAGE = 'hwn-stamps-extra';
const KOMOOT_STORAGE = 'hwn-komoot-links';
const VARIANT_STORAGE = 'hwn-tour-variants';
const PROGRESS_FORMAT = 'hwn-tourenplan-progress';
// Start and end closer than this are shown as one "Start/Ziel" marker
const LOOP_CLOSE_METERS = 250;

// Region colors, readable on paper and on OSM tiles
const REGION_COLORS = {
    A: '#1F7A6A', B: '#3457A8', C: '#7550A8', D: '#B04A22',
    E: '#7C6C10', F: '#AD2F63', G: '#3F7F2E', H: '#5A6070'
};
const STAMPED_COLOR = '#9A958A';

// Season hint from the highest point of the tour (track or highest stamp)
const SEASON_TAGS = [
    { below: 600, label: 'ganzjährig', hint: 'Unter 600 m: auch im Winter meist ohne Schnee machbar' },
    { below: 800, label: 'Apr–Nov', hint: 'Mittlere Höhe: im Winter oft Schnee, sonst gut machbar' },
    { below: Infinity, label: 'Mai–Okt', hint: 'Hochlage über 800 m: von etwa November bis März mit Schnee und Eis rechnen' }
];

const el = id => document.getElementById(id);

let initialized = false;
let map = null;
let plan = null;
let stampsByNumber = new Map();
let collected = new Set();        // stamp numbers; the only source of progress
let variants = {};                // tourId -> 'parts' when a tour is walked as its part tours
let units = [];                   // every walkable tour: suggestions and their part tours
const unitById = new Map();
let regionFilter = null;
let selectedId = null;

let projectTracks = {};           // tourId -> {name, gpx}
let uploadedTracks = {};          // tourId -> {name, gpx, uploadedAt}
const tracks = new Map();         // tourId -> {source, name, gpx, ...analyzeTrack()}
const trackErrors = new Map();    // tourId -> message for a file that couldn't be used
let komootLinks = {};             // tourId -> [{url, name}] added in the browser (project links live in tours.json)
let detailMessage = null;         // {tourId, text, isError} shown once in the detail panel

const loopLines = new Map();      // tourId -> visible polyline
const hitLines = new Map();       // tourId -> wide invisible polyline for clicks
const stampMarkers = new Map();   // stamp number -> circleMarker
let labelLayer = null;
let endpointLayer = null;

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

const fmt1 = n => n.toFixed(1).replace('.', ',');
const color = code => REGION_COLORS[code] || '#3D3563';

function lighten(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const channel = shift => {
        const c = (n >> shift) & 255;
        return Math.round(c + (255 - c) * amount);
    };
    return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

// The second part of a split tour is drawn in a lighter shade of the region color
const unitColor = unit => unit.parent && unit.index === 1 ? lighten(color(unit.region), 0.45) : color(unit.region);
const unitLabel = unit => unit.parent ? `Teil ${unit.id}` : `Vorschlag ${unit.id}`;

// Part tours behave like tours of their own (track, Komoot links, checkbox) and know their parent
function buildUnits() {
    plan.tours.forEach(tour => {
        tour.parts = (tour.parts || []).map((part, index) => ({
            ...part, region: tour.region, single: false, tags: tour.tags, parent: tour, index
        }));
    });
    units = plan.tours.flatMap(t => [t, ...t.parts]);
    unitById.clear();
    units.forEach(u => unitById.set(u.id, u));
}

function usesParts(tour) {
    return tour.parts?.length > 0 && variants[tour.id] === 'parts';
}

// What is walked: the whole tour, or its parts when that variant is chosen
function isShown(unit) {
    return unit.parent ? usesParts(unit.parent) : !usesParts(unit);
}

function shownUnits() {
    return units.filter(isShown);
}

function isSelected(unit) {
    return selectedId === unit.id || (!!unit.parent && selectedId === unit.parent.id);
}

function sanitizeVariants(data) {
    const result = {};
    Object.entries(data || {}).forEach(([id, v]) => {
        if (v === 'parts' && unitById.get(id)?.parts?.length) result[id] = 'parts';
    });
    return result;
}

function loadVariants() {
    try {
        return sanitizeVariants(JSON.parse(localStorage.getItem(VARIANT_STORAGE) || '{}'));
    } catch {
        return {};
    }
}

function saveVariants() {
    try {
        localStorage.setItem(VARIANT_STORAGE, JSON.stringify(variants));
    } catch {
        // ignore
    }
}

function setVariant(tour, useParts) {
    if (useParts) variants[tour.id] = 'parts';
    else delete variants[tour.id];
    saveVariants();
    updateLines();
    renderList();
    render();
}

function loadSet(key) {
    try {
        return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    } catch {
        return new Set();
    }
}

function saveSet(key, set) {
    try {
        localStorage.setItem(key, JSON.stringify([...set]));
    } catch {
        // ignore
    }
}

// Komoot: accept a tour link (komoot.com/.de, any locale) or a bare tour id
function parseKomootUrl(input) {
    const text = input.trim();
    if (/^\d{5,}$/.test(text)) return `https://www.komoot.com/de-de/tour/${text}`;
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }
    if (!/(^|\.)komoot\.(com|de)$/i.test(url.hostname)) return null;
    // Plain tour pages are normalized; anything else (collections, share links) is kept as is
    const id = url.pathname.match(/\/tour\/(\d+)/)?.[1];
    return id && !url.search ? `https://www.komoot.com/de-de/tour/${id}` : url.href;
}

// Komoot's GPX export is named like "2026-09-26_3310815718_Ilsetal.gpx"
function komootUrlFromFilename(name) {
    const id = name.match(/^\d{4}-\d{2}-\d{2}_(\d{5,})_/)?.[1];
    return id ? `https://www.komoot.com/de-de/tour/${id}` : null;
}

function loadKomootLinks() {
    try {
        const data = JSON.parse(localStorage.getItem(KOMOOT_STORAGE) || '{}');
        return data && typeof data === 'object' ? data : {};
    } catch {
        return {};
    }
}

function saveKomootLinks() {
    try {
        localStorage.setItem(KOMOOT_STORAGE, JSON.stringify(komootLinks));
    } catch {
        // ignore
    }
}

// Only well-formed links for known tours survive (storage and imports are untrusted)
function sanitizeKomootLinks(data, tourIds) {
    const result = {};
    Object.entries(data || {}).forEach(([id, links]) => {
        if (!tourIds.has(id) || !Array.isArray(links)) return;
        const valid = links
            .map(l => ({ url: parseKomootUrl(String(l?.url || '')), name: l?.name ? String(l.name) : '' }))
            .filter(l => l.url);
        if (valid.length) result[id] = valid;
    });
    return result;
}

// Project links first, then browser links; the same tour is listed once
function tourKomootLinks(tour) {
    const seen = new Set();
    return [
        ...(tour.komoot || []).map(l => ({ ...l, source: 'project' })),
        ...(komootLinks[tour.id] || []).map(l => ({ ...l, source: 'browser' }))
    ].filter(l => !seen.has(l.url) && seen.add(l.url));
}

function komootLabel(link) {
    const id = link.url.match(/\/tour\/(\d+)/)?.[1];
    return link.name || (id ? `Komoot-Tour ${id}` : 'Komoot');
}

function addKomootLink(tour, url, name = '') {
    if (tourKomootLinks(tour).some(l => l.url === url)) return false;
    komootLinks[tour.id] = [...(komootLinks[tour.id] || []), { url, name }];
    saveKomootLinks();
    return true;
}

function removeKomootLink(tour, url) {
    komootLinks[tour.id] = (komootLinks[tour.id] || []).filter(l => l.url !== url);
    if (!komootLinks[tour.id].length) delete komootLinks[tour.id];
    saveKomootLinks();
}

// Stamps of the given tours (unknown ids are ignored)
function stampsOfTours(tourIds) {
    const result = new Set();
    plan.tours.filter(t => tourIds.has(t.id)).forEach(t => t.stamps.forEach(n => result.add(n)));
    return result;
}

function validStamps(numbers) {
    return new Set([...numbers].map(Number).filter(n => stampsByNumber.has(n)));
}

// Progress lives only in browser storage. Older versions stored finished tours plus extra
// stamps; those are converted once and then left untouched.
function loadCollected() {
    let stored = null;
    try {
        stored = localStorage.getItem(COLLECTED_STORAGE);
    } catch {
        // storage unavailable: start empty
    }
    if (stored !== null) return validStamps(loadSet(COLLECTED_STORAGE));

    const migrated = stampsOfTours(loadSet(LEGACY_DONE_STORAGE));
    loadSet(LEGACY_EXTRA_STORAGE).forEach(n => migrated.add(n));
    const result = validStamps(migrated);
    saveSet(COLLECTED_STORAGE, result);
    return result;
}

function saveCollected() {
    saveSet(COLLECTED_STORAGE, collected);
}

function collectedStamps() {
    return collected;
}

function collectedCount(tour) {
    return tour.stamps.filter(n => collected.has(n)).length;
}

function isDone(tour) {
    return collectedCount(tour) === tour.stamps.length;
}

function isPartial(tour) {
    const n = collectedCount(tour);
    return n > 0 && n < tour.stamps.length;
}

// The tour checkbox collects or removes all of its stamps (each stamp belongs to one tour)
function setTourCollected(tour, on) {
    tour.stamps.forEach(n => on ? collected.add(n) : collected.delete(n));
    saveCollected();
}

function setStampCollected(number, on) {
    on ? collected.add(number) : collected.delete(number);
    saveCollected();
}

function tourStamps(tour) {
    return tour.stamps.map(n => stampsByNumber.get(n)).filter(Boolean);
}

function regionName(code) {
    return plan.regions.find(r => r.code === code)?.name || code;
}

function shortRegionName(code) {
    return regionName(code).split(':')[0];
}

/**
 * Figures for a tour: from its GPX track when there is one, otherwise the plan's estimate.
 * Walking time uses the plan's formula (4 km/h plus ~6 min per stamp).
 */
function tourFigures(tour) {
    const track = tracks.get(tour.id);
    if (!track) {
        return { real: false, realAscent: false, km: tour.km, hours: tour.hours, ascent: tour.ascent, minEle: tour.minEle, maxEle: tour.maxEle };
    }
    return {
        real: true,
        km: track.km,
        hours: track.km / 4 + tour.stamps.length * 0.1,
        // A track without elevation keeps the plan's (lower-bound) ascent
        realAscent: track.ascent !== null,
        ascent: track.ascent ?? tour.ascent,
        minEle: track.minEle ?? tour.minEle,
        maxEle: track.maxEle ?? tour.maxEle
    };
}

/**
 * Difficulty from distance and climbing: "Leistungs-km" = km + Hm / 100, plus the highest point.
 * Real track ascent (with valleys and hills between stamps) is much higher than the stamp-to-stamp
 * estimate, so each source has its own thresholds. Without real elevation the result is an estimate.
 */
const LEVEL_RULES = {
    track: { mittel: 25, anspruchsvoll: 32 },
    estimate: { mittel: 21, anspruchsvoll: 26.5, mittelEle: 650 }
};
const LEVEL_HIGH_ELE = 850;

function tourLevel(tour) {
    const f = tourFigures(tour);
    const rule = f.realAscent ? LEVEL_RULES.track : LEVEL_RULES.estimate;
    const effort = f.km + f.ascent / 100;
    let level = 'leicht';
    if (f.maxEle >= LEVEL_HIGH_ELE || effort >= rule.anspruchsvoll) level = 'anspruchsvoll';
    else if (effort >= rule.mittel || (rule.mittelEle && f.maxEle >= rule.mittelEle)) level = 'mittel';
    return { level, effort, estimated: !f.realAscent };
}

function levelHtml(tour) {
    const { level, effort, estimated } = tourLevel(tour);
    const title = `${fmt1(effort)} Leistungs-km (km + Hm/100)${estimated ? ', aus geschätzten Werten' : ', aus dem GPX-Track'}`;
    return `<span class="level lv-${level}" title="${title}">${estimated ? '~' : ''}${level}</span>`;
}

// Season tag from the current highest point first, then the tour's own hints from tours.json
function tourTags(tour) {
    const season = SEASON_TAGS.find(t => tourFigures(tour).maxEle < t.below);
    return [season, ...tour.tags];
}

// Tracks computed by OpenRouteService (project defaults or "Auf Wanderwege legen") are only suggestions
function isSuggestedTrack(track) {
    return /OpenRouteService/.test(track.gpx.slice(0, 2000));
}

function trackKind(tour, track) {
    if (isSuggestedTrack(track)) return 'Routenvorschlag (OpenRouteService, ungeprüft)';
    if (track.source === 'project') return 'Track aus dem Projekt';
    return isDone(tour) ? 'Gelaufener Track' : 'Geplanter Track';
}

function loopLatLngs(tour) {
    const track = tracks.get(tour.id);
    if (track) return track.latLngs;
    if (tour.single) return [];
    const latLngs = tourStamps(tour).map(s => [s.lat, s.lon]);
    latLngs.push(latLngs[0]);
    return latLngs;
}

/**
 * Start and end points of a tour's GPX track, one pair per segment (none without a track).
 * A loop (start ≈ end) collapses into a single "Start/Ziel" point.
 * @returns {Array<{latLng: number[], kind: 'start'|'end'|'both', title: string}>}
 */
function tourEndpoints(tour) {
    // Only a real track has a known start; the straight-line loop could start at any stamp
    const track = tracks.get(tour.id);
    if (!track) return [];
    const segments = track.latLngs;
    const multi = segments.filter(seg => seg.length).length > 1;

    return segments.filter(seg => seg.length).flatMap((seg, i) => {
        const part = multi ? ` (Teil ${i + 1})` : '';
        const start = seg[0];
        const end = seg[seg.length - 1];
        const gap = distanceMeters(start[0], start[1], end[0], end[1]);
        if (gap < LOOP_CLOSE_METERS) {
            return [{ latLng: start, kind: 'both', title: `Start/Ziel${part}` }];
        }
        return [
            { latLng: start, kind: 'start', title: `Start${part}` },
            { latLng: end, kind: 'end', title: `Ziel${part}` }
        ];
    });
}

function renderEndpoints() {
    endpointLayer.clearLayers();
    const selected = shownUnits().filter(isSelected);
    // With a selection only that tour (or its parts) gets large markers; otherwise every visible tour gets small ones
    const tours = selected.length ? selected : shownUnits().filter(t => !regionFilter || t.region === regionFilter);

    tours.forEach(tour => {
        const big = selected.includes(tour);
        tourEndpoints(tour).forEach(p => {
            const label = { start: 'S', end: 'Z', both: 'S/Z' }[p.kind];
            const marker = L.marker(p.latLng, {
                icon: L.divIcon({
                    className: 'endpoint-marker',
                    html: big
                        ? `<div class="endpoint-pin ${p.kind}"><span>${label}</span></div>`
                        : `<div class="endpoint-dot ${p.kind}"></div>`,
                    iconSize: big ? [30, 30] : [10, 10],
                    // Pins point at the spot from above so the stop number underneath stays visible
                    iconAnchor: big ? [15, 36] : [5, 5]
                }),
                keyboard: false,
                zIndexOffset: big ? 3000 : 0
            })
                .bindTooltip(`${unitLabel(tour)} · ${p.title}`)
                .on('click', () => select(tour.id))
                .addTo(endpointLayer);
            if (isDone(tour) && !big) marker.setOpacity(0.6);
        });
    });
}

/**
 * Show the tour plan. Loads data and builds the map on first call.
 * @param {Array} stamps - All stamps in internal format
 */
export async function showTourPlan(stamps) {
    if (initialized) {
        map.invalidateSize();
        return;
    }
    initialized = true;

    const response = await fetch('./data/tours.json');
    if (!response.ok) {
        throw new Error('Konnte Tourenplan nicht laden');
    }
    plan = await response.json();
    stampsByNumber = new Map(stamps.map(s => [s.number, s]));
    buildUnits();
    collected = loadCollected();
    variants = loadVariants();
    komootLinks = sanitizeKomootLinks(loadKomootLinks(), new Set(units.map(u => u.id)));

    initTourMap();
    initProgressTransfer();
    renderChips();
    renderList();
    render();

    // Tracks load in the background; the straight-line plan is usable meanwhile
    [projectTracks, uploadedTracks] = await Promise.all([
        loadProjectTracks(units.map(u => u.id)),
        loadUploadedTracks()
    ]);
    refreshTracks();
}

// Rebuild the effective track per tour (upload beats project file) and redraw
function refreshTracks() {
    tracks.clear();
    trackErrors.clear();
    units.forEach(tour => {
        const upload = uploadedTracks[tour.id];
        const project = projectTracks[tour.id];
        const candidates = [
            upload && { source: 'upload', ...upload },
            project && { source: 'project', ...project }
        ].filter(Boolean);

        for (const c of candidates) {
            try {
                tracks.set(tour.id, { ...c, ...analyzeTrack(c.gpx, tourStamps(tour)) });
                break;
            } catch (e) {
                trackErrors.set(tour.id, `${c.name}: ${e.message}`);
            }
        }
    });

    updateLines();
    renderList();
    render();
}

// Only the chosen variant of each tour is drawn (and clickable)
function updateLines() {
    units.forEach(unit => {
        const latLngs = isShown(unit) ? loopLatLngs(unit) : [];
        loopLines.get(unit.id).setLatLngs(latLngs);
        hitLines.get(unit.id).setLatLngs(latLngs);
    });
}

function initTourMap() {
    map = L.map('tourMap', { scrollWheelZoom: false }).setView(HARZ_CENTER, 9);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    const loopLayer = L.layerGroup().addTo(map);
    const pointLayer = L.layerGroup().addTo(map);
    endpointLayer = L.layerGroup().addTo(map);
    labelLayer = L.layerGroup().addTo(map);

    units.forEach(tour => {
        const latLngs = isShown(tour) ? loopLatLngs(tour) : [];

        const line = L.polyline(latLngs, {
            color: unitColor(tour),
            weight: 3,
            opacity: 0.85,
            lineJoin: 'round',
            interactive: false
        }).addTo(loopLayer);

        // Wide transparent line makes the loop easy to hit
        const hit = L.polyline(latLngs, { weight: 16, opacity: 0 })
            .bindTooltip(() => {
                const f = tourFigures(tour);
                return `${unitLabel(tour)} · ${tour.stamps.length} Stempel · ${f.real ? '' : 'ca. '}${fmt1(f.km)} km`
                    + (f.real ? ' · GPX' : '')
                    + (isDone(tour) ? ' · erledigt' : isPartial(tour) ? ` · ${collectedCount(tour)}/${tour.stamps.length} gestempelt` : '');
            }, { sticky: true })
            .on('click', () => select(tour.id))
            .addTo(loopLayer);

        loopLines.set(tour.id, line);
        hitLines.set(tour.id, hit);
    });

    const tourOf = new Map();
    plan.tours.forEach(t => t.stamps.forEach(n => tourOf.set(n, t)));

    // Color and size depend on progress and are set in render()
    stampsByNumber.forEach((stamp, number) => {
        const tour = tourOf.get(number);
        const marker = L.circleMarker([stamp.lat, stamp.lon], {
            radius: 5.5,
            color: '#FFFFFF',
            weight: 1.5,
            fillColor: tour ? color(tour.region) : STAMPED_COLOR,
            fillOpacity: 1
        });
        marker.bindTooltip(() =>
            `<span class="stamp-id">${stamp.id}</span>${escapeHtml(stamp.name)}`
            + (collectedStamps().has(number) ? ' · gestempelt' : tour ? ` · Vorschlag ${tour.id}` : '')
        );
        // A split tour shown in parts selects the part that contains the stamp
        if (tour) marker.on('click', () => select(
            (usesParts(tour) && tour.parts.find(p => p.stamps.includes(number))?.id) || tour.id));
        marker.addTo(pointLayer);
        stampMarkers.set(number, marker);
    });

    fitTo(shownUnits());
}

function fitTo(tours) {
    const pts = tours.flatMap(t => [...tourStamps(t).map(s => [s.lat, s.lon]), ...(tracks.get(t.id)?.latLngs.flat() || [])]);
    if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 13 });
}

function renderChips() {
    const chips = el('tourChips');
    const make = (code, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'region-chip';
        b.dataset.code = code || '';
        b.style.setProperty('--c', code ? color(code) : 'var(--ink)');
        b.innerHTML = (code ? `<i></i><span class="mono">${code}</span> ` : '') + escapeHtml(label);
        b.addEventListener('click', () => {
            regionFilter = code;
            if (selectedId && code && !selectedId.startsWith(code)) selectedId = null;
            render();
            fitTo(shownUnits().filter(t => !code || t.region === code));
        });
        chips.appendChild(b);
    };
    make(null, 'Alle Regionen');
    plan.regions.forEach(r => make(r.code, shortRegionName(r.code)));
}

function renderList() {
    const list = el('tourList');
    list.innerHTML = '';

    plan.regions.forEach(region => {
        const tours = plan.tours.filter(t => t.region === region.code);
        if (!tours.length) return;
        const shown = shownUnits().filter(t => t.region === region.code);
        const km = shown.reduce((a, t) => a + tourFigures(t).km, 0);
        const count = tours.reduce((a, t) => a + t.stamps.length, 0);
        const withTrack = shown.filter(t => tracks.has(t.id)).length;

        const sec = document.createElement('section');
        sec.className = 'card region-card';
        sec.dataset.code = region.code;
        sec.style.setProperty('--c', color(region.code));
        sec.innerHTML = `
            <header class="region-head">
                <h3><span class="mono region-code">${region.code}</span> ${escapeHtml(region.name)}</h3>
                <span class="region-sub">${tours.length} Vorschläge · ${count} Stempel · ${Math.round(km)} km${withTrack ? ` · ${withTrack} mit GPX` : ''} · ca. ${tours[0].driveKm} km Anfahrt ab ${escapeHtml(plan.home)}</span>
            </header>
            <div class="table-wrap">
                <table class="tour-table">
                    <thead><tr>
                        <th scope="col">Erledigt</th><th scope="col">Vorschlag</th>
                        <th scope="col" class="r">km</th><th scope="col" class="r">Std.</th><th scope="col" class="r">Hm</th>
                        <th scope="col">Niveau, Zeit</th><th scope="col">Stempel in Reihenfolge</th>
                    </tr></thead>
                    <tbody></tbody>
                </table>
            </div>`;

        const tbody = sec.querySelector('tbody');
        tours.forEach(tour => [tour, ...tour.parts].forEach(unit => tbody.appendChild(createTourRow(unit))));
        list.appendChild(sec);
    });
}

function createTourRow(tour) {
    const tr = document.createElement('tr');
    tr.className = tour.parent ? 'tour-row part-row' : 'tour-row';
    tr.tabIndex = 0;
    tr.dataset.id = tour.id;

    const dash = '–';
    const f = tourFigures(tour);
    const noFigures = tour.single && !f.real;
    // Estimates are marked: "~" for distance/time, "≥" for ascent (only stamp-to-stamp climbs)
    const est = f.real ? '' : '<span class="est">~</span>';
    const seq = tourStamps(tour)
        .map(s => `<span class="seq-stop"><span class="mono">${s.number}</span> ${escapeHtml(s.name)}</span>`)
        .join(' → ');

    tr.innerHTML = `
        <td><input type="checkbox" class="tour-done" aria-label="Alle Stempel von ${unitLabel(tour)} gesammelt"><span class="done-count mono"></span></td>
        <td class="tour-id mono">${tour.parent ? '<span class="part-arrow" aria-hidden="true">↳</span>' : ''}${tour.id}${tour.parts?.length ? '<span class="gpx-tag parts-tag" title="Lässt sich in zwei Teilen gehen">2 Teile</span>' : ''}${f.real ? '<span class="gpx-tag" title="Mit GPX-Track">GPX</span>' : ''}${tourKomootLinks(tour).length ? '<span class="gpx-tag komoot-tag" title="Mit Komoot-Link">komoot</span>' : ''}</td>
        <td class="r mono">${noFigures ? dash : est + fmt1(f.km)}</td>
        <td class="r mono">${noFigures ? dash : est + fmt1(f.hours)}</td>
        <td class="r mono">${noFigures ? dash : (f.realAscent ? '' : '<span class="est">≥</span>') + f.ascent}</td>
        <td>${tour.single ? '' : `${levelHtml(tour)}<br>`}${tourTags(tour)
            .map(g => `<span class="season" title="${escapeHtml(g.hint)}">${escapeHtml(g.label)}</span>`).join('')}</td>
        <td class="seq">${tour.single ? '<span class="detour-tag">Abstecher</span> ' : ''}${tour.parent ? `<span class="part-name">${escapeHtml(tour.name)}:</span> ` : ''}${seq}</td>`;

    const cb = tr.querySelector('.tour-done');
    syncDoneCheckbox(cb, tour);
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => {
        setTourCollected(tour, cb.checked);
        render();
    });

    tr.addEventListener('click', () => select(tour.id, true));
    tr.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(tour.id, true);
        }
    });
    return tr;
}

// Checked = all stamps collected, indeterminate = some; a click on a partial tour collects the rest
function syncDoneCheckbox(cb, tour) {
    cb.checked = isDone(tour);
    cb.indeterminate = isPartial(tour);
    const count = cb.parentElement?.querySelector('.done-count');
    if (count) count.textContent = isPartial(tour) ? `${collectedCount(tour)}/${tour.stamps.length}` : '';
}

function select(id, scrollToMap = false) {
    const tour = unitById.get(id);
    // Opening a part switches its tour to the part variant
    if (tour?.parent && !usesParts(tour.parent)) {
        variants[tour.parent.id] = 'parts';
        saveVariants();
        updateLines();
        renderList();
    }
    selectedId = id;
    if (tour && regionFilter && tour.region !== regionFilter) regionFilter = null;
    render();
    if (tour) fitTo(usesParts(tour) ? tour.parts : [tour]);
    if (scrollToMap) el('tourMapGrid').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function render() {
    el('tourChips').querySelectorAll('.region-chip').forEach(b =>
        b.setAttribute('aria-pressed', String((b.dataset.code || null) === regionFilter)));

    const collected = collectedStamps();
    shownUnits().forEach(tour => {
        const visible = !regionFilter || tour.region === regionFilter;
        const done = isDone(tour);
        const real = tracks.has(tour.id);
        const line = loopLines.get(tour.id);
        const isSel = isSelected(tour);
        const dim = !visible || (selectedId && !isSel);
        // Real tracks are drawn stronger than straight-line estimates;
        // finished tours stay visible, but dashed so open tours stand out
        line.setStyle({
            weight: isSel ? 5 : (real ? 3.5 : 2.5),
            opacity: dim ? 0.15 : (done && !isSel ? 0.6 : (real ? 0.95 : 0.75)),
            dashArray: done && !isSel ? '6 7' : null
        });
        if (isSel) line.bringToFront();

        tour.stamps.forEach(n => {
            const m = stampMarkers.get(n);
            if (!m) return;
            const got = collected.has(n);
            m.setRadius(got ? 4 : 5.5);
            m.setStyle({
                fillColor: got ? STAMPED_COLOR : color(tour.region),
                opacity: dim ? 0.25 : 1,
                fillOpacity: dim ? 0.25 : 1
            });
        });
    });

    renderEndpoints();

    labelLayer.clearLayers();
    const tour = unitById.get(selectedId);
    // Stop numbers of the selection; parts are prefixed with their letter (a1, a2, b1, ...)
    shownUnits().filter(isSelected).forEach(unit => {
        const prefix = unit.parent ? 'ab'[unit.index] : '';
        tourStamps(unit).forEach((s, i) => {
            L.marker([s.lat, s.lon], {
                icon: L.divIcon({
                    className: 'stop-marker',
                    html: `<div class="stop-marker-inner" style="background:${unitColor(unit)}">${prefix}${i + 1}</div>`,
                    iconSize: [28, 28],
                    iconAnchor: [14, 14]
                }),
                title: `${prefix}${i + 1}. ${s.name}`,
                zIndexOffset: 2000
            }).addTo(labelLayer);
        });
    });

    el('tourList').querySelectorAll('.region-card').forEach(sec => {
        sec.hidden = !!regionFilter && sec.dataset.code !== regionFilter;
    });
    el('tourList').querySelectorAll('.tour-row').forEach(row => {
        row.classList.toggle('selected', row.dataset.id === selectedId);
        const rowTour = unitById.get(row.dataset.id);
        row.classList.toggle('done', isDone(rowTour));
        row.classList.toggle('variant-off', !isShown(rowTour));
        const cb = row.querySelector('.tour-done');
        if (cb) syncDoneCheckbox(cb, rowTour);
    });

    renderStats();
    renderDetail(tour);
}

function renderStats() {
    const collected = collectedStamps();
    const openStamps = stampsByNumber.size - collected.size;
    // Split tours count with the chosen variant (whole or parts), never both
    const openList = shownUnits().filter(t => !isDone(t));
    const openKm = openList.reduce((a, t) => a + tourFigures(t).km, 0);
    const openKmEstimated = openList.some(t => !t.single && !tracks.has(t.id));
    // Estimated ascent only counts climbs between stamps, so it's a lower bound ("≥")
    const openHm = openList.reduce((a, t) => a + tourFigures(t).ascent, 0);
    // Single stamps (car detour) have no distance or ascent, so nothing there is estimated
    const estimatedAscent = t => !t.single && !tourFigures(t).realAscent;
    const openHmEstimated = openList.some(estimatedAscent);

    // Walked distance: real track where there is one, otherwise the plan's estimate
    const doneList = shownUnits().filter(isDone);
    const walkedKm = doneList.reduce((a, t) => a + tourFigures(t).km, 0);
    const walkedHm = doneList.reduce((a, t) => a + tourFigures(t).ascent, 0);
    const walkedEstimated = doneList.some(t => !t.single && !tracks.has(t.id));
    const walkedHmEstimated = doneList.some(estimatedAscent);
    const hm = n => Math.round(n).toLocaleString('de-DE');

    el('tourStats').innerHTML = `
        <div class="route-stat"><div class="label">Stempel gesammelt</div><div class="value highlight">${collected.size}</div></div>
        <div class="route-stat"><div class="label">Offene Stempel</div><div class="value">${openStamps}</div></div>
        <div class="route-stat"><div class="label">Rundtouren</div><div class="value">${plan.tours.filter(t => !t.single).length}</div></div>
        <div class="route-stat"${openKmEstimated ? ' title="Teilweise geschätzt: nicht jede offene Tour hat einen GPX-Track"' : ''}><div class="label">km offen</div><div class="value">${openKmEstimated ? '~' : ''}${Math.round(openKm)}</div></div>
        <div class="route-stat"${openHmEstimated ? ' title="Teilweise geschätzt (nur Anstiege von Stempel zu Stempel), echte Höhenmeter liegen meist höher"' : ''}><div class="label">Hm offen</div><div class="value">${openHmEstimated ? '≥' : ''}${hm(openHm)}</div></div>
        <div class="route-stat"${walkedEstimated ? ' title="Teilweise geschätzt: nicht jede erledigte Tour hat einen GPX-Track"' : ''}><div class="label">km zurückgelegt</div><div class="value highlight">${walkedEstimated ? '~' : ''}${fmt1(walkedKm)}</div></div>
        <div class="route-stat"${walkedHmEstimated ? ' title="Teilweise geschätzt: nicht jede erledigte Tour hat einen GPX-Track mit Höhendaten"' : ''}><div class="label">Hm zurückgelegt</div><div class="value highlight">${walkedHmEstimated ? '≥' : ''}${hm(walkedHm)}</div></div>
        <div class="route-stat"><div class="label">Vorschläge erledigt</div><div class="value highlight">${plan.tours.filter(isDone).length}</div></div>`;
}

function trackInfoHtml(tour) {
    const track = tracks.get(tour.id);
    const error = trackErrors.get(tour.id);
    const parts = [];

    if (track) {
        const source = track.source === 'upload' ? 'im Browser hinterlegt' : 'Projektdatei';
        parts.push(`<p class="hint track-source"><b>${trackKind(tour, track)}:</b> <span class="mono">${escapeHtml(track.name)}</span> · ${source}`
            + (track.source === 'upload' && projectTracks[tour.id] ? ' (ersetzt die Projektdatei)' : '') + '</p>');
        if (track.missed.length) {
            const list = track.missed
                .map(m => `${m.number} ${escapeHtml(stampsByNumber.get(m.number)?.name || '')} (${Math.round(m.distance)} m)`)
                .join(', ');
            parts.push(`<p class="hint track-warning">⚠ Nicht am Track (mehr als ${STAMP_ON_TRACK_METERS} m entfernt): ${list}</p>`);
        }
    } else {
        parts.push(`<p class="hint">Noch kein GPX-Track. Lade eine geplante oder gelaufene Tour hoch (z. B. aus Komoot), dann zeigt die Karte den echten Weg statt der Luftlinie. Der Erledigt-Status ändert sich dadurch nicht.</p>`);
    }
    if (error) {
        parts.push(`<p class="hint track-warning">⚠ ${escapeHtml(error)}</p>`);
    }
    if (detailMessage?.tourId === tour.id && !detailMessage.komoot) {
        parts.push(`<p class="hint ${detailMessage.isError ? 'track-warning' : 'track-ok'}">${escapeHtml(detailMessage.text)}</p>`);
    }
    return parts.join('');
}

function renderDetail(tour) {
    const detail = el('tourDetail');

    if (!tour) {
        detail.style.removeProperty('--c');
        const tours = regionFilter ? plan.tours.filter(t => t.region === regionFilter) : plan.tours;
        const count = tours.reduce((a, t) => a + t.stamps.length, 0);
        const km = Math.round(shownUnits().filter(t => !regionFilter || t.region === regionFilter)
            .reduce((a, t) => a + tourFigures(t).km, 0));
        detail.innerHTML = `
            <h3>${regionFilter ? escapeHtml(regionName(regionFilter)) : 'Tour auswählen'}</h3>
            <p class="hint">${regionFilter
                ? `${tours.length} Touren mit ${count} Stempeln, zusammen etwa ${km} km.`
                : 'Tippe auf eine farbige Runde in der Karte oder auf eine Zeile in der Liste.'}</p>
            <p class="hint">Für Tagesausflüge ab ${escapeHtml(plan.home)} liegen die Regionen A bis C am nächsten. E bis H lohnen sich eher als Wochenende mit Übernachtung.</p>`;
        return;
    }

    const stamps = tourStamps(tour);
    const f = tourFigures(tour);
    const track = tracks.get(tour.id);
    detail.style.setProperty('--c', unitColor(tour));

    const ca = f.real ? '' : 'ca. ';
    const meta = tour.single && !f.real
        ? '<span>Abstecher mit dem Auto</span>'
        : `<span>${ca}${fmt1(f.km)} km</span><span>ca. ${fmt1(f.hours)} Std.</span><span>${f.realAscent ? '' : 'mind. '}${f.ascent} Hm</span>`
            + (tour.single ? '' : levelHtml(tour));

    // Round trip: start and end at the first stamp, the others as waypoints
    const ll = s => `${s.lat},${s.lon}`;
    const mapsUrl = tour.single
        ? `https://www.google.com/maps?q=${ll(stamps[0])}`
        : `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${ll(stamps[0])}`
            + `&destination=${ll(stamps[0])}&waypoints=${encodeURIComponent(stamps.slice(1).map(ll).join('|'))}`;

    detail.innerHTML = `
        <span class="region-tag">${escapeHtml(regionName(tour.region))}</span>
        <h3>${tour.parent ? 'Teil' : 'Vorschlag'} <span class="mono">${tour.id}</span>${tour.parent ? ` <span class="part-title">${escapeHtml(tour.name)}</span>` : ''}${isDone(tour)
            ? ' <span class="level lv-leicht">✓ erledigt</span>'
            : isPartial(tour) ? ` <span class="level lv-mittel">${collectedCount(tour)}/${stamps.length} gestempelt</span>` : ''}</h3>
        <div class="tour-meta mono">${meta}<span>${f.minEle}–${f.maxEle} m ü. NN</span><span>${stamps.length} Stempel</span></div>
        ${tour.parent ? partInfoHtml(tour) : '<p class="hint suggestion-hint">Vorschlag aus dem Tourenplan: Du kannst ihn so gehen, mit eigenem GPX anpassen oder nur einzelne Stempel davon sammeln.</p>'}
        ${tour.parts?.length ? variantHtml(tour) : ''}
        <ul class="tips">${tourTags(tour).map(g => `<li><b>${escapeHtml(g.label)}:</b> ${escapeHtml(g.hint)}</li>`).join('')}</ul>
        <ol class="stop-list">${stamps.map((s, i) => `
            <li class="stop-item${collected.has(s.number) ? ' collected' : ''}">
                <span class="stop-number">${i + 1}</span>
                <span class="stop-name">${escapeHtml(s.name)}</span>
                <span class="stop-id">${s.id}${s.elevation ? ` · ${s.elevation} m` : ''}</span>
                <label class="stamp-check" title="Gestempelt"><input type="checkbox" class="stamp-done" data-stamp="${s.number}"${collected.has(s.number) ? ' checked' : ''} aria-label="${escapeHtml(`${s.id} ${s.name} gestempelt`)}"></label>
            </li>`).join('')}
        </ol>
        <p class="hint">${tour.single
            ? 'Liegt zu abseits für eine Runde; nimm ihn auf dem Weg zu einer Nachbartour mit.'
            : 'Die Runde ist geschlossen, du kannst an jedem Stempel starten.'}</p>
        <div class="done-box">
            <label><input type="checkbox" id="tourDoneToggle"> Alle Stempel gesammelt</label>
            <span class="hint">Setzt oder entfernt die Haken aller Stempel ${tour.parent ? 'dieses Teils' : 'dieses Vorschlags'}. Einzelne Stempel hakst du in der Liste oben ab. Ein GPX-Track allein ändert am Fortschritt nichts.</span>
        </div>
        <div class="track-box">
            ${trackInfoHtml(tour)}
            <div class="detail-actions">
                <button type="button" class="calc-route-btn" id="trackUpload">${track ? 'GPX ersetzen' : 'GPX hinterlegen'}</button>
                ${tour.single ? '' : `<button type="button" class="calc-route-btn" id="trackRoute" title="Runde durch die Stempel auf Wanderwegen berechnen (OpenRouteService)">${track ? 'Neu auf Wanderwege legen' : 'Auf Wanderwege legen'}</button>`}
                ${track?.source === 'upload' ? '<button type="button" class="detail-clear" id="trackRemove">Hochgeladenen Track entfernen</button>' : ''}
                <input type="file" id="trackFile" accept=".gpx,application/gpx+xml,text/xml,application/xml" hidden>
            </div>
        </div>
        <div class="komoot-box">
            <b>Komoot</b>
            ${komootHtml(tour)}
            <form class="komoot-add" id="komootForm">
                <input type="text" id="komootInput" placeholder="komoot.com/tour/… oder Tour-ID" aria-label="Komoot-Link hinzufügen" autocomplete="off">
                <button type="submit" class="calc-route-btn">Verlinken</button>
            </form>
        </div>
        <div class="detail-actions">
            <button type="button" class="selection-btn primary" id="tourGpx">${track ? 'GPX-Track herunterladen' : 'GPX herunterladen'}</button>
            <button type="button" class="calc-route-btn" id="tourCompare" title="${track ? 'Track' : 'Luftlinien-Runde'} im Routenabgleich gegen alle Stempel prüfen">Im Routenabgleich prüfen</button>
            <a class="detail-link" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">Google Maps →</a>
            <button type="button" class="detail-clear" id="tourClear">Auswahl aufheben</button>
        </div>`;

    // Without a track: straight-line loop through the stamps
    const tourGpx = () => track ? track.gpx : generateGPX(stamps, {
        name: `HWN Tour ${tour.id}`,
        description: `${regionName(tour.region)} · ${stamps.length} Stempel · ca. ${fmt1(tour.km)} km`,
        closeLoop: !tour.single
    });
    el('tourGpx').addEventListener('click', () => downloadGPX(tourGpx(), `HWN_${tour.id}`));
    // app.js owns the comparison view; hand the route over without importing it here
    el('tourCompare').addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('hwn:compare-route', {
            detail: { gpx: tourGpx(), name: track ? `${unitLabel(tour)}: ${track.name}` : `${unitLabel(tour)} (Luftlinie)` }
        }));
    });
    el('tourClear').addEventListener('click', () => {
        selectedId = null;
        render();
        fitTo(shownUnits().filter(t => !regionFilter || t.region === regionFilter));
    });

    const fileInput = el('trackFile');
    el('trackUpload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) uploadTrack(tour, file);
    });
    el('trackRemove')?.addEventListener('click', () => removeUploadedTrack(tour));
    el('trackRoute')?.addEventListener('click', e => routeTour(tour, e.currentTarget));
    const doneToggle = el('tourDoneToggle');
    syncDoneCheckbox(doneToggle, tour);
    doneToggle.addEventListener('change', e => {
        setTourCollected(tour, e.target.checked);
        render();
    });
    el('tourParent')?.addEventListener('click', () => select(tour.parent.id));
    detail.querySelectorAll('input[name="tourVariant"]').forEach(radio =>
        radio.addEventListener('change', () => setVariant(tour, radio.value === 'parts')));
    detail.querySelectorAll('[data-part]').forEach(btn =>
        btn.addEventListener('click', () => select(btn.dataset.part)));
    detail.querySelectorAll('.stamp-done').forEach(cb =>
        cb.addEventListener('change', () => {
            setStampCollected(Number(cb.dataset.stamp), cb.checked);
            render();
        }));

    el('komootForm').addEventListener('submit', e => {
        e.preventDefault();
        const input = el('komootInput');
        const url = parseKomootUrl(input.value);
        if (!url) {
            detailMessage = { tourId: tour.id, text: 'Das ist kein Komoot-Link.', isError: true, komoot: true };
        } else if (!addKomootLink(tour, url)) {
            detailMessage = { tourId: tour.id, text: 'Dieser Link ist schon hinterlegt.', isError: true, komoot: true };
        } else {
            detailMessage = null;
        }
        renderList();
        render();
        if (!url) el('komootInput').value = input.value;
    });
    el('tourDetail').querySelectorAll('[data-komoot-remove]').forEach(btn =>
        btn.addEventListener('click', () => {
            removeKomootLink(tour, btn.dataset.komootRemove);
            renderList();
            render();
        }));
}

function partInfoHtml(part) {
    const sibling = part.parent.parts.find(p => p !== part);
    return `<p class="hint suggestion-hint">Teil von Vorschlag ${part.parent.id}: eine eigene Runde. Zusammen mit
        Teil ${sibling.id} (${escapeHtml(sibling.name)}) deckt er alle Stempel des Vorschlags ab.</p>
        <button type="button" class="detail-clear" id="tourParent">← Zu Vorschlag ${part.parent.id}</button>`;
}

// Choose between walking a long tour whole or as its two part tours
function variantHtml(tour) {
    const parts = usesParts(tour);
    const whole = tourFigures(tour);
    const partRows = tour.parts.map(p => {
        const f = tourFigures(p);
        const est = f.real ? '' : '~';
        return `<li>
            <button type="button" class="part-link" data-part="${p.id}"><span class="mono">${p.id}</span> ${escapeHtml(p.name)}</button>
            <span class="mono">${est}${fmt1(f.km)} km · ${f.realAscent ? '' : '≥'}${f.ascent} Hm</span>${levelHtml(p)}
        </li>`;
    }).join('');
    return `<div class="variant-box">
        <b>Gehen als</b>
        <div class="variant-switch" role="radiogroup" aria-label="Variante">
            <label><input type="radio" name="tourVariant" value="whole"${parts ? '' : ' checked'}> Komplett (${whole.real ? '' : '~'}${fmt1(whole.km)} km)</label>
            <label><input type="radio" name="tourVariant" value="parts"${parts ? ' checked' : ''}> In zwei Teilen</label>
        </div>
        <ul class="variant-parts">${partRows}</ul>
        <p class="hint">Die Teile sind eigene Runden mit eigenem Track; öffne einen Teil, um ihn abzuhaken oder einen Track zu hinterlegen.
            Karte und „km/Hm offen“ zeigen die gewählte Variante.${parts ? ' Track und Downloads unten gelten für die komplette Runde.' : ''}</p>
    </div>`;
}

function komootHtml(tour) {
    const links = tourKomootLinks(tour);
    const items = links.map(l => `
        <li>
            <a class="detail-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(komootLabel(l))} →</a>
            ${l.source === 'browser'
                ? `<button type="button" class="detail-clear" data-komoot-remove="${escapeHtml(l.url)}" title="Link entfernen" aria-label="Link entfernen">×</button>`
                : '<span class="hint" title="Steht in src/data/tours.json">Projekt</span>'}
        </li>`).join('');
    const msg = detailMessage?.tourId === tour.id && detailMessage.komoot
        ? `<p class="hint ${detailMessage.isError ? 'track-warning' : 'track-ok'}">${escapeHtml(detailMessage.text)}</p>`
        : '';
    return (links.length ? `<ul class="komoot-links">${items}</ul>` : '<p class="hint">Noch keine Komoot-Tour verlinkt.</p>') + msg;
}

async function uploadTrack(tour, file) {
    const setMessage = (text, isError) => {
        detailMessage = { tourId: tour.id, text, isError };
        render();
    };
    try {
        const gpx = await file.text();
        // Validate before storing so a broken file doesn't replace a working track
        analyzeTrack(gpx, tourStamps(tour));
        const record = { name: file.name, gpx, uploadedAt: new Date().toISOString() };
        await saveUploadedTrack(tour.id, record);
        uploadedTracks[tour.id] = record;
        const komootUrl = komootUrlFromFilename(file.name);
        const linked = komootUrl && addKomootLink(tour, komootUrl);
        detailMessage = { tourId: tour.id, text: linked ? 'Track gespeichert und Komoot-Tour verlinkt.' : 'Track gespeichert.', isError: false };
        refreshTracks();
        fitTo([tour]);
    } catch (e) {
        setMessage(`Track nicht übernommen: ${e.message || 'Speichern fehlgeschlagen.'}`, true);
    }
}

// Snap the straight-line loop to hiking paths via OpenRouteService; stored like an upload (planning only)
async function routeTour(tour, button) {
    const setMessage = (text, isError) => {
        detailMessage = { tourId: tour.id, text, isError };
        render();
    };
    if (!hasApiKey()) {
        setMessage('Dafür brauchst du einen OpenRouteService-API-Schlüssel. Hinterlege ihn im Tab Routenabgleich unter den API-Einstellungen.', true);
        return;
    }
    const existing = tracks.get(tour.id);
    if (existing && !confirm(`${unitLabel(tour)} hat schon einen Track (${existing.name}). Durch die berechnete Route ersetzen?`
        + (existing.source === 'project' ? '\nDie Projektdatei bleibt erhalten und gilt wieder, wenn du den hochgeladenen Track entfernst.' : ''))) {
        return;
    }

    button.disabled = true;
    button.textContent = 'Berechne …';
    const stamps = tourStamps(tour);
    const result = await calculateHikingTrack([...stamps, stamps[0]]);
    if (result.error) {
        setMessage(`Route nicht berechnet: ${result.error}`, true);
        return;
    }

    const name = `OpenRouteService – Tour ${tour.id}`;
    try {
        const gpx = coordinatesToGPX(name, result.coordinates);
        analyzeTrack(gpx, stamps);
        const record = { name, gpx, uploadedAt: new Date().toISOString() };
        await saveUploadedTrack(tour.id, record);
        uploadedTracks[tour.id] = record;
        detailMessage = { tourId: tour.id, text: 'Route auf Wanderwegen gespeichert (geplant). Prüfe sie auf der Karte, ORS kennt nicht jeden Pfad.', isError: false };
        refreshTracks();
        fitTo([tour]);
    } catch (e) {
        setMessage(`Route nicht gespeichert: ${e.message || 'Speichern fehlgeschlagen.'}`, true);
    }
}

async function removeUploadedTrack(tour) {
    try {
        await deleteUploadedTrack(tour.id);
        delete uploadedTracks[tour.id];
        detailMessage = { tourId: tour.id, text: 'Hochgeladener Track entfernt.', isError: false };
        refreshTracks();
    } catch {
        detailMessage = { tourId: tour.id, text: 'Track konnte nicht entfernt werden.', isError: true };
        render();
    }
}

// Progress backup: export/import as JSON so it survives a cleared browser storage

function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function setTransferStatus(msg, isError = false) {
    const status = el('progressStatus');
    status.textContent = msg;
    status.classList.toggle('error', isError);
}

function exportProgress() {
    const today = new Date().toISOString().slice(0, 10);
    // Only uploads are exported; project files already live in the repository
    const exportedTracks = Object.fromEntries(
        Object.entries(uploadedTracks).map(([id, t]) => [id, { name: t.name, gpx: t.gpx, uploadedAt: t.uploadedAt }]));
    downloadJSON({
        format: PROGRESS_FORMAT,
        version: 3,
        exportedAt: new Date().toISOString(),
        // v3: stamps are authoritative; doneTours is derived and kept for older app versions
        stamps: [...collected].sort((a, b) => a - b),
        doneTours: plan.tours.filter(isDone).map(t => t.id),
        tracks: exportedTracks,
        komoot: komootLinks,
        variants
    }, `hwn-fortschritt-${today}.json`);
    const n = Object.keys(exportedTracks).length;
    setTransferStatus(`Fortschritt exportiert${n ? ` (mit ${n} GPX-Track${n > 1 ? 's' : ''})` : ''}.`);
}

async function importProgress(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('Datei ist kein gültiges JSON.');
    }
    if (data?.format !== PROGRESS_FORMAT || !Array.isArray(data.stamps)
        || (data.doneTours !== undefined && !Array.isArray(data.doneTours))) {
        throw new Error('Datei ist kein HWN-Fortschritt-Export.');
    }

    const tourIds = new Set(units.map(u => u.id));
    const doneIds = data.doneTours || [];
    const unknownTours = doneIds.filter(id => !tourIds.has(id));

    // The file replaces the browser state. Older files (v1/v2) may list a finished tour
    // without all of its stamps, so both are combined.
    const imported = stampsOfTours(new Set(doneIds));
    data.stamps.forEach(n => imported.add(n));
    collected = validStamps(imported);
    saveCollected();

    // Older exports have no tracks; then the uploaded tracks in the browser stay untouched
    let trackCount = null;
    if (data.tracks && typeof data.tracks === 'object') {
        const valid = Object.entries(data.tracks)
            .filter(([id, t]) => tourIds.has(id) && typeof t?.gpx === 'string')
            .map(([id, t]) => [id, { name: String(t.name || `${id}.gpx`), gpx: t.gpx, uploadedAt: t.uploadedAt || null }]);
        await clearUploadedTracks();
        for (const [id, record] of valid) await saveUploadedTrack(id, record);
        uploadedTracks = Object.fromEntries(valid);
        trackCount = valid.length;
    }
    // Same for Komoot links: only replaced when the file has them
    if (data.komoot && typeof data.komoot === 'object') {
        komootLinks = sanitizeKomootLinks(data.komoot, tourIds);
        saveKomootLinks();
    }
    // Same for the chosen variants of split tours
    if (data.variants && typeof data.variants === 'object') {
        variants = sanitizeVariants(data.variants);
        saveVariants();
    }
    refreshTracks();

    const doneCount = plan.tours.filter(isDone).length;
    let msg = `Importiert: ${doneCount} ${doneCount === 1 ? 'Vorschlag' : 'Vorschläge'} erledigt, ${collected.size} Stempel gesammelt`;
    msg += trackCount === null ? '.' : `, ${trackCount} GPX-Track${trackCount === 1 ? '' : 's'}.`;
    setTransferStatus(unknownTours.length ? `${msg} Unbekannte Touren ignoriert: ${unknownTours.join(', ')}` : msg);
}

function initProgressTransfer() {
    const input = el('progressFile');
    el('progressExport').addEventListener('click', exportProgress);
    el('progressImport').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                await importProgress(reader.result);
            } catch (e) {
                setTransferStatus(e.message || 'Import fehlgeschlagen.', true);
            }
            input.value = '';
        };
        reader.onerror = () => setTransferStatus('Fehler beim Lesen der Datei.', true);
        reader.readAsText(file);
    });
}
