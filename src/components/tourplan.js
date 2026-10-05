// Tourenplan: suggested round tours ("Vorschläge") covering all stamps, grouped by region.
// Has its own Leaflet map so it doesn't interfere with the route comparison map.
// Tours can carry a real GPX track (project file or browser upload) that replaces the straight-line loop.
// Progress is stored per stamp; a tour counts as done when all of its stamps are collected.
// Long tours can have two part tours ("parts" in tours.json); each tour is shown either whole or in parts.
// Own tours (GPX + detected stamps, planned or walked) are stored in the browser next to the suggestions.

import { generateGPX, downloadGPX } from "../utils/optimize.js";
import {
    analyzeTrack, loadProjectTracks, loadUploadedTracks, saveUploadedTrack,
    deleteUploadedTrack, clearUploadedTracks, coordinatesToGPX, STAMP_ON_TRACK_METERS,
    loadOwnTours, saveOwnTour, deleteOwnTour, clearOwnTours, stampsAlongTrack, gpxName
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
// Straight line to path distance, the same factor as the estimates in tours.json
const ROUTE_FACTOR = 1.4;

// Region colors, readable on paper and on OSM tiles
const REGION_COLORS = {
    A: '#1F7A6A', B: '#3457A8', C: '#7550A8', D: '#B04A22',
    E: '#7C6C10', F: '#AD2F63', G: '#3F7F2E', H: '#5A6070'
};
const STAMPED_COLOR = '#9A958A';
const OWN_REGION = 'own';
const OWN_COLOR = '#3D2A6B';
const OWN_ID = /^own-[\w-]{1,40}$/;

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
let units = [];                   // every walkable tour: suggestions, their part tours, own tours
const unitById = new Map();
let ownTours = [];                // own tour records as stored: {id, name, gpx, fileName, stamps, status, createdAt}
let ownDraft = null;              // own tour being created or edited (form in the detail panel)
let ownDeleteId = null;           // own tour waiting for the delete confirmation
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
let loopLayer = null;
let restLayer = null;             // straight-line loops of reduced suggestions
let labelLayer = null;
let endpointLayer = null;
let draftLine = null;             // preview of the GPX in the own tour form

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

const fmt1 = n => n.toFixed(1).replace('.', ',');
const color = code => code === OWN_REGION ? OWN_COLOR : REGION_COLORS[code] || '#3D3563';

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
const unitLabel = unit => unit.own ? `Eigene Tour „${unit.name}“` : unit.parent ? `Teil ${unit.id}` : `Vorschlag ${unit.id}`;

// Part tours behave like tours of their own (track, Komoot links, checkbox) and know their parent
function prepareParts() {
    plan.tours.forEach(tour => {
        tour.parts = (tour.parts || []).map((part, index) => ({
            ...part, region: tour.region, single: false, tags: tour.tags, parent: tour, index
        }));
    });
}

// Own tours get their figures from their GPX; the estimate fields are only a fallback for a broken file
function ownUnit(record) {
    const stamps = record.stamps.filter(n => stampsByNumber.has(n));
    const eles = stamps.map(n => stampsByNumber.get(n).elevation).filter(Number.isFinite);
    return {
        id: record.id, name: record.name, own: true, record, region: OWN_REGION, stamps, single: false, tags: [],
        km: 0, hours: 0, ascent: 0, minEle: eles.length ? Math.min(...eles) : 0, maxEle: eles.length ? Math.max(...eles) : 0
    };
}

function buildUnits() {
    units = [...plan.tours.flatMap(t => [t, ...t.parts]), ...ownTours.map(ownUnit)];
    unitById.clear();
    units.forEach(u => unitById.set(u.id, u));
}

const ownUnits = () => units.filter(u => u.own);
// Suggestions (whole or as parts) without the own tours
const suggestionUnits = () => shownUnits().filter(u => !u.own);

// Storage and imports are untrusted: keep only well-formed own tours
function sanitizeOwnRecord(r) {
    if (!r || typeof r !== 'object' || !OWN_ID.test(String(r.id)) || typeof r.gpx !== 'string' || !r.gpx.includes('<gpx')) return null;
    const name = String(r.name || '').trim().slice(0, 120);
    if (!name || !Array.isArray(r.stamps)) return null;
    return {
        id: String(r.id),
        name,
        gpx: r.gpx,
        fileName: r.fileName ? String(r.fileName).slice(0, 200) : '',
        stamps: [...validStamps(r.stamps)],
        status: r.status === 'walked' ? 'walked' : 'planned',
        createdAt: r.createdAt ? String(r.createdAt) : new Date().toISOString()
    };
}

// Replace the own tours (after loading, saving, deleting or importing) and redraw everything
function setOwnTours(records) {
    ownTours = records;
    const before = ownUnits().map(u => u.id);
    buildUnits();
    before.filter(id => !unitById.has(id)).forEach(removeUnitLines);
    units.filter(u => !loopLines.has(u.id)).forEach(addUnitLines);
    if (selectedId && !unitById.has(selectedId)) selectedId = null;
    if (regionFilter === OWN_REGION && !ownTours.length) regionFilter = null;
    renderChips();
    refreshTracks();
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
function sanitizeKomootLinks(data, isKnownId) {
    const result = {};
    Object.entries(data || {}).forEach(([id, links]) => {
        if (!isKnownId(id) || !Array.isArray(links)) return;
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

// Own tours are done when marked as walked; suggestions when all of their stamps are collected
function isDone(tour) {
    if (tour.own) return tour.record.status === 'walked';
    return collectedCount(tour) === tour.stamps.length;
}

function isPartial(tour) {
    if (tour.own) return false;
    const n = collectedCount(tour);
    return n > 0 && n < tour.stamps.length;
}

// The tour checkbox collects or removes all of its stamps (each stamp belongs to one suggestion)
function setTourCollected(tour, on) {
    if (tour.own) {
        setOwnWalked(tour, on);
        return;
    }
    tour.stamps.forEach(n => on ? collected.add(n) : collected.delete(n));
    saveCollected();
}

// Walking an own tour collects its stamps; undoing it removes them again,
// except those another walked own tour covers as well
function setOwnWalked(unit, on) {
    unit.record.status = on ? 'walked' : 'planned';
    if (on) {
        unit.stamps.forEach(n => collected.add(n));
    } else {
        const keep = new Set(ownUnits().filter(u => u !== unit && isDone(u)).flatMap(u => u.stamps));
        unit.stamps.filter(n => !keep.has(n)).forEach(n => collected.delete(n));
    }
    saveCollected();
    saveOwnTour(unit.record).catch(() => {
        detailMessage = { tourId: unit.id, text: 'Status konnte nicht gespeichert werden.', isError: true };
        render();
    });
}

function setStampCollected(number, on) {
    on ? collected.add(number) : collected.delete(number);
    saveCollected();
}

// Open stamps that a planned (not yet walked) own tour will cover, with the tour that covers them
function plannedStampOwners() {
    const owners = new Map();
    ownUnits().filter(u => !isDone(u)).forEach(u => u.stamps.forEach(n => {
        if (!collected.has(n) && !owners.has(n)) owners.set(n, u);
    }));
    return owners;
}

// What is left of a suggestion: stamps neither collected nor planned in an own tour (in the suggestion's order)
function restStamps(tour, owners = plannedStampOwners()) {
    return tour.stamps.filter(n => !collected.has(n) && !owners.has(n));
}

// Same estimate as tours.json: closed straight-line loop x 1.4, climbs between stamps, 4 km/h + 6 min per stamp
function estimateLoop(stamps) {
    let meters = 0;
    let ascent = 0;
    if (stamps.length > 1) {
        stamps.forEach((s, i) => {
            const next = stamps[(i + 1) % stamps.length];
            meters += distanceMeters(s.lat, s.lon, next.lat, next.lon);
            ascent += Math.max(0, (next.elevation || 0) - (s.elevation || 0));
        });
    }
    const km = meters * ROUTE_FACTOR / 1000;
    const eles = stamps.map(s => s.elevation).filter(Number.isFinite);
    return {
        km, hours: km / 4 + stamps.length * 0.1, ascent: Math.round(ascent),
        minEle: eles.length ? Math.min(...eles) : 0, maxEle: eles.length ? Math.max(...eles) : 0
    };
}

/**
 * Figures for what is still to walk of a suggestion: the tour itself while nothing is collected
 * or planned elsewhere, an estimate for the remaining loop otherwise, nothing when no stamp is left.
 * @returns {Object} - tourFigures() fields plus {rest, reduced, empty}
 */
function restFigures(tour, owners = plannedStampOwners()) {
    const rest = restStamps(tour, owners);
    if (rest.length === tour.stamps.length) return { ...tourFigures(tour), rest, reduced: false, empty: false };
    if (!rest.length) {
        return { real: true, realAscent: true, km: 0, hours: 0, ascent: 0, minEle: 0, maxEle: 0, rest, reduced: true, empty: true };
    }
    return { ...estimateLoop(rest.map(n => stampsByNumber.get(n))), real: false, realAscent: false, rest, reduced: true, empty: false };
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

function tourLevel(tour, f = tourFigures(tour)) {
    const rule = f.realAscent ? LEVEL_RULES.track : LEVEL_RULES.estimate;
    const effort = f.km + f.ascent / 100;
    let level = 'leicht';
    if (f.maxEle >= LEVEL_HIGH_ELE || effort >= rule.anspruchsvoll) level = 'anspruchsvoll';
    else if (effort >= rule.mittel || (rule.mittelEle && f.maxEle >= rule.mittelEle)) level = 'mittel';
    return { level, effort, estimated: !f.realAscent };
}

function levelHtml(tour, f = tourFigures(tour)) {
    const { level, effort, estimated } = tourLevel(tour, f);
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
    prepareParts();
    buildUnits();
    collected = loadCollected();
    variants = loadVariants();
    // Own tours load later, so their links are kept by id pattern
    komootLinks = sanitizeKomootLinks(loadKomootLinks(), id => unitById.has(id) || OWN_ID.test(id));

    initTourMap();
    initProgressTransfer();
    initOwnTours();
    renderChips();
    renderList();
    render();

    // Tracks load in the background; the straight-line plan is usable meanwhile
    let ownRecords;
    [projectTracks, uploadedTracks, ownRecords] = await Promise.all([
        loadProjectTracks(units.map(u => u.id)),
        loadUploadedTracks(),
        loadOwnTours().catch(() => [])
    ]);
    setOwnTours(ownRecords.map(sanitizeOwnRecord).filter(Boolean));
}

// Rebuild the effective track per tour (upload beats project file) and redraw
function refreshTracks() {
    tracks.clear();
    trackErrors.clear();
    units.forEach(tour => {
        const upload = uploadedTracks[tour.id];
        const project = projectTracks[tour.id];
        const candidates = tour.own
            ? [{ source: 'own', name: tour.record.fileName || `${tour.name}.gpx`, gpx: tour.record.gpx }]
            : [
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

    loopLayer = L.layerGroup().addTo(map);
    restLayer = L.layerGroup().addTo(map);
    const pointLayer = L.layerGroup().addTo(map);
    draftLine = L.polyline([], { color: OWN_COLOR, weight: 4, opacity: 0.9, dashArray: '2 8', interactive: false }).addTo(map);
    endpointLayer = L.layerGroup().addTo(map);
    labelLayer = L.layerGroup().addTo(map);

    units.forEach(addUnitLines);

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

function addUnitLines(tour) {
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
            return `${escapeHtml(unitLabel(tour))} · ${tour.stamps.length} Stempel · ${f.real ? '' : 'ca. '}${fmt1(f.km)} km`
                + (f.real && !tour.own ? ' · GPX' : '')
                + (isDone(tour) ? (tour.own ? ' · gelaufen' : ' · erledigt') : isPartial(tour) ? ` · ${collectedCount(tour)}/${tour.stamps.length} gestempelt` : '');
        }, { sticky: true })
        .on('click', () => select(tour.id))
        .addTo(loopLayer);

    loopLines.set(tour.id, line);
    hitLines.set(tour.id, hit);
}

function removeUnitLines(id) {
    loopLines.get(id)?.remove();
    hitLines.get(id)?.remove();
    loopLines.delete(id);
    hitLines.delete(id);
}

function fitTo(tours) {
    const pts = tours.flatMap(t => [...tourStamps(t).map(s => [s.lat, s.lon]), ...(tracks.get(t.id)?.latLngs.flat() || [])]);
    if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 13 });
}

function renderChips() {
    const chips = el('tourChips');
    chips.innerHTML = '';
    const make = (code, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'region-chip';
        b.dataset.code = code || '';
        b.style.setProperty('--c', code ? color(code) : 'var(--ink)');
        b.innerHTML = (code === OWN_REGION ? '<i></i>' : code ? `<i></i><span class="mono">${code}</span> ` : '') + escapeHtml(label);
        b.addEventListener('click', () => {
            regionFilter = code;
            if (selectedId && code && !selectedId.startsWith(code)) selectedId = null;
            render();
            fitTo(shownUnits().filter(t => !code || t.region === code));
        });
        chips.appendChild(b);
    };
    make(null, 'Alle Regionen');
    if (ownTours.length) make(OWN_REGION, 'Eigene Touren');
    plan.regions.forEach(r => make(r.code, shortRegionName(r.code)));
}

function renderList() {
    const list = el('tourList');
    list.innerHTML = '';
    if (ownTours.length) list.appendChild(createOwnSection());

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

function createOwnSection() {
    const own = ownUnits();
    const km = own.reduce((a, t) => a + tourFigures(t).km, 0);
    const walked = own.filter(isDone).length;
    const sec = document.createElement('section');
    sec.className = 'card region-card own-card';
    sec.dataset.code = OWN_REGION;
    sec.style.setProperty('--c', OWN_COLOR);
    sec.innerHTML = `
        <header class="region-head">
            <h3>Eigene Touren</h3>
            <span class="region-sub">${own.length} ${own.length === 1 ? 'Tour' : 'Touren'} · ${walked} gelaufen · ${Math.round(km)} km · im Browser gespeichert</span>
        </header>
        <div class="table-wrap">
            <table class="tour-table">
                <thead><tr>
                    <th scope="col">Gelaufen</th><th scope="col">Tour</th>
                    <th scope="col" class="r">km</th><th scope="col" class="r">Std.</th><th scope="col" class="r">Hm</th>
                    <th scope="col">Niveau, Zeit</th><th scope="col">Stempel am Track</th>
                </tr></thead>
                <tbody></tbody>
            </table>
        </div>`;
    const tbody = sec.querySelector('tbody');
    own.forEach(unit => tbody.appendChild(createTourRow(unit)));
    return sec;
}

function createTourRow(tour) {
    const tr = document.createElement('tr');
    tr.className = tour.parent ? 'tour-row part-row' : tour.own ? 'tour-row own-row' : 'tour-row';
    tr.tabIndex = 0;
    tr.dataset.id = tour.id;

    const f = tourFigures(tour);
    const idCell = tour.own
        ? `<span class="own-name">${escapeHtml(tour.name)}</span>`
        : `${tour.parent ? '<span class="part-arrow" aria-hidden="true">↳</span>' : ''}${tour.id}${tour.parts?.length ? '<span class="gpx-tag parts-tag" title="Lässt sich in zwei Teilen gehen">2 Teile</span>' : ''}${f.real ? '<span class="gpx-tag" title="Mit GPX-Track">GPX</span>' : ''}`;

    tr.innerHTML = `
        <td><input type="checkbox" class="tour-done" aria-label="${escapeHtml(unitLabel(tour))} ${tour.own ? 'gelaufen' : ': alle Stempel gesammelt'}"><span class="done-count mono"></span></td>
        <td class="tour-id mono">${idCell}${tourKomootLinks(tour).length ? '<span class="gpx-tag komoot-tag" title="Mit Komoot-Link">komoot</span>' : ''}</td>
        <td class="r mono"></td><td class="r mono"></td><td class="r mono"></td><td></td><td class="seq"></td>`;
    fillRowCells(tr, tour);

    const cb = tr.querySelector('.tour-done');
    syncDoneCheckbox(cb, tour);
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => {
        setTourCollected(tour, cb.checked);
        if (tour.own) renderList();
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

/**
 * Figures, level and stamps of a list row. An open suggestion shows what is left of it
 * (estimated when stamps are collected or planned in an own tour).
 */
function fillRowCells(tr, tour, owners = plannedStampOwners()) {
    const cells = tr.querySelectorAll('td');
    const dash = '–';
    const f = !tour.own && !isDone(tour) ? restFigures(tour, owners) : tourFigures(tour);
    const noFigures = (tour.single && !f.real) || f.empty;
    // Estimates are marked: "~" for distance/time, "≥" for ascent (only stamp-to-stamp climbs)
    const est = f.real ? '' : '<span class="est">~</span>';
    const restTitle = !f.reduced ? ''
        : f.empty ? 'Alle offenen Stempel sind in eigenen Touren verplant' : `Rest: ${f.rest.join(', ')} (geschätzt)`;
    const seq = tourStamps(tour)
        .map(s => {
            const state = collected.has(s.number) ? ' got' : owners.has(s.number) && !tour.own ? ' planned' : '';
            const hint = state === ' got' ? ' title="gestempelt"' : state ? ` title="${escapeHtml(`verplant in „${owners.get(s.number).name}“`)}"` : '';
            return `<span class="seq-stop${state}"${hint}><span class="mono">${s.number}</span> ${escapeHtml(s.name)}</span>`;
        })
        .join(' → ') || '<span class="hint">Keine Stempel am Track</span>';

    cells[2].innerHTML = noFigures ? dash : est + fmt1(f.km);
    cells[3].innerHTML = noFigures ? dash : est + fmt1(f.hours);
    cells[4].innerHTML = noFigures ? dash : (f.realAscent ? '' : '<span class="est">≥</span>') + f.ascent;
    [2, 3, 4].forEach(i => restTitle ? cells[i].setAttribute('title', restTitle) : cells[i].removeAttribute('title'));
    cells[5].innerHTML = `${tour.single || f.empty ? '' : `${levelHtml(tour, f)}<br>`}${tourTags(tour)
        .map(g => `<span class="season" title="${escapeHtml(g.hint)}">${escapeHtml(g.label)}</span>`).join('')}`;
    cells[6].innerHTML = `${tour.single ? '<span class="detour-tag">Abstecher</span> ' : ''}${tour.parent ? `<span class="part-name">${escapeHtml(tour.name)}:</span> ` : ''}${f.reduced && !f.empty ? '<span class="gpx-tag rest-tag">Rest</span> ' : ''}${seq}`;
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
    const owners = plannedStampOwners();
    restLayer.clearLayers();
    shownUnits().forEach(tour => {
        const visible = !regionFilter || tour.region === regionFilter;
        const done = isDone(tour);
        const real = tracks.has(tour.id);
        const line = loopLines.get(tour.id);
        const isSel = isSelected(tour);
        const dim = !visible || (selectedId && !isSel);
        // A suggestion that is partly collected or planned elsewhere fades; its rest is drawn as a dotted loop
        const rest = tour.own || done ? null : restStamps(tour, owners);
        const reduced = rest && rest.length < tour.stamps.length;
        // Real tracks are drawn stronger than straight-line estimates;
        // finished tours stay visible, but dashed so open tours stand out
        line.setStyle({
            weight: isSel ? 5 : (real ? 3.5 : 2.5),
            opacity: dim ? 0.15 : (reduced && !isSel ? 0.35 : done && !isSel ? 0.6 : (real ? 0.95 : 0.75)),
            dashArray: done && !isSel ? '6 7' : null
        });
        if (isSel) line.bringToFront();
        if (reduced && rest.length > 1) {
            const latLngs = rest.map(n => stampsByNumber.get(n)).map(s => [s.lat, s.lon]);
            L.polyline([...latLngs, latLngs[0]], {
                color: unitColor(tour), weight: 3, opacity: dim ? 0.15 : 0.95, dashArray: '1 7', lineCap: 'round', interactive: false
            }).addTo(restLayer);
        }
    });

    // Stamp markers keep the color of their suggestion; dimmed when outside the selection or filter
    const selectedStamps = new Set(shownUnits().filter(isSelected).flatMap(u => u.stamps));
    const ownStamps = new Set(ownUnits().flatMap(u => u.stamps));
    plan.tours.forEach(tour => tour.stamps.forEach(n => {
        const m = stampMarkers.get(n);
        if (!m) return;
        const visible = !regionFilter || tour.region === regionFilter || (regionFilter === OWN_REGION && ownStamps.has(n));
        const dim = !visible || (selectedId && !selectedStamps.has(n));
        const got = collected.has(n);
        m.setRadius(got ? 4 : 5.5);
        m.setStyle({
            fillColor: got ? STAMPED_COLOR : color(tour.region),
            opacity: dim ? 0.25 : 1,
            fillOpacity: dim ? 0.25 : 1
        });
    }));
    draftLine.setLatLngs(ownDraft?.latLngs || []);

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
        fillRowCells(row, rowTour, owners);
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
    // Every open stamp counts once: planned own tours with their track, plus what is left of each
    // open suggestion (split tours with the chosen variant, never both)
    const owners = plannedStampOwners();
    const openList = [
        ...ownUnits().filter(u => !isDone(u)).map(u => ({ tour: u, f: tourFigures(u) })),
        ...suggestionUnits().filter(t => !isDone(t)).map(t => ({ tour: t, f: restFigures(t, owners) }))
    ];
    const openKm = openList.reduce((a, x) => a + x.f.km, 0);
    // Single stamps (car detour) have no distance or ascent, so nothing there is estimated
    const openKmEstimated = openList.some(x => !x.tour.single && !x.f.real);
    // Estimated ascent only counts climbs between stamps, so it's a lower bound ("≥")
    const openHm = openList.reduce((a, x) => a + x.f.ascent, 0);
    const openHmEstimated = openList.some(x => !x.tour.single && !x.f.realAscent);
    const estimatedAscent = t => !t.single && !tourFigures(t).realAscent;

    // Walked distance: walked own tours, plus finished suggestions (real track where there is one,
    // otherwise the estimate). A suggestion finished partly through own tours isn't counted again.
    const walkedOwn = ownUnits().filter(isDone);
    const walkedOwnStamps = new Set(walkedOwn.flatMap(u => u.stamps));
    const doneList = [
        ...suggestionUnits().filter(t => isDone(t) && !t.stamps.some(n => walkedOwnStamps.has(n))),
        ...walkedOwn
    ];
    const walkedKm = doneList.reduce((a, t) => a + tourFigures(t).km, 0);
    const walkedHm = doneList.reduce((a, t) => a + tourFigures(t).ascent, 0);
    const walkedEstimated = doneList.some(t => !t.single && !tracks.has(t.id));
    const walkedHmEstimated = doneList.some(estimatedAscent);
    const hm = n => Math.round(n).toLocaleString('de-DE');

    el('tourStats').innerHTML = `
        <div class="route-stat"><div class="label">Stempel gesammelt</div><div class="value highlight">${collected.size}</div></div>
        <div class="route-stat"><div class="label">Offene Stempel</div><div class="value">${openStamps}</div></div>`
        + (owners.size ? `<div class="route-stat" title="Offene Stempel, die in geplanten eigenen Touren liegen"><div class="label">davon verplant</div><div class="value">${owners.size}</div></div>` : '')
        + `
        <div class="route-stat"><div class="label">Rundtouren</div><div class="value">${plan.tours.filter(t => !t.single).length}</div></div>
        <div class="route-stat" title="Geplante eigene Touren plus der Rest der offenen Vorschläge${openKmEstimated ? '; teilweise geschätzt (ohne GPX-Track oder Rest-Runde)' : ''}"><div class="label">km offen</div><div class="value">${openKmEstimated ? '~' : ''}${Math.round(openKm)}</div></div>
        <div class="route-stat"${openHmEstimated ? ' title="Teilweise geschätzt (nur Anstiege von Stempel zu Stempel), echte Höhenmeter liegen meist höher"' : ''}><div class="label">Hm offen</div><div class="value">${openHmEstimated ? '≥' : ''}${hm(openHm)}</div></div>
        <div class="route-stat"${walkedEstimated ? ' title="Teilweise geschätzt: nicht jede erledigte Tour hat einen GPX-Track"' : ''}><div class="label">km zurückgelegt</div><div class="value highlight">${walkedEstimated ? '~' : ''}${fmt1(walkedKm)}</div></div>
        <div class="route-stat"${walkedHmEstimated ? ' title="Teilweise geschätzt: nicht jede erledigte Tour hat einen GPX-Track mit Höhendaten"' : ''}><div class="label">Hm zurückgelegt</div><div class="value highlight">${walkedHmEstimated ? '≥' : ''}${hm(walkedHm)}</div></div>
        <div class="route-stat"><div class="label">Vorschläge erledigt</div><div class="value highlight">${plan.tours.filter(isDone).length}</div></div>`
        + (ownTours.length ? `<div class="route-stat"><div class="label">Eigene Touren gelaufen</div><div class="value highlight">${walkedOwn.length}/${ownTours.length}</div></div>` : '');
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

    if (ownDraft) {
        renderOwnForm(detail);
        return;
    }
    if (!tour && regionFilter === OWN_REGION) {
        detail.style.setProperty('--c', OWN_COLOR);
        const own = ownUnits();
        detail.innerHTML = `
            <h3>Eigene Touren</h3>
            <p class="hint">${own.length} ${own.length === 1 ? 'Tour' : 'Touren'}, davon ${own.filter(isDone).length} gelaufen. Wähle eine Tour in der Liste oder auf der Karte.</p>`;
        return;
    }
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

    if (tour.own) {
        renderOwnDetail(detail, tour);
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
        ${restHtml(tour)}
        ${tipsHtml(tour)}
        ${stopListHtml(stamps)}
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
                ${track && !tour.single ? '<button type="button" class="calc-route-btn" id="tourAdopt" title="Kopiert Track und Stempel in eine eigene Tour, die du anpassen kannst">Als eigene Tour übernehmen</button>' : ''}
                ${track?.source === 'upload' ? '<button type="button" class="detail-clear" id="trackRemove">Hochgeladenen Track entfernen</button>' : ''}
                <input type="file" id="trackFile" accept=".gpx,application/gpx+xml,text/xml,application/xml" hidden>
            </div>
        </div>
        ${komootBoxHtml(tour)}
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
    bindDetailCommon(detail, tour, {
        gpx: tourGpx,
        fileName: `HWN_${tour.id}`,
        compareName: track ? `${unitLabel(tour)}: ${track.name}` : `${unitLabel(tour)} (Luftlinie)`
    });

    const fileInput = el('trackFile');
    el('trackUpload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) uploadTrack(tour, file);
    });
    el('trackRemove')?.addEventListener('click', () => removeUploadedTrack(tour));
    el('trackRoute')?.addEventListener('click', e => routeTour(tour, e.currentTarget));
    el('restRoute')?.addEventListener('click', e => routeRest(tour, e.currentTarget));
    el('tourAdopt')?.addEventListener('click', e => adoptSuggestion(tour, e.currentTarget));
    detail.querySelectorAll('[data-own]').forEach(btn =>
        btn.addEventListener('click', () => select(btn.dataset.own)));
    el('tourParent')?.addEventListener('click', () => select(tour.parent.id));
    detail.querySelectorAll('input[name="tourVariant"]').forEach(radio =>
        radio.addEventListener('change', () => setVariant(tour, radio.value === 'parts')));
    detail.querySelectorAll('[data-part]').forEach(btn =>
        btn.addEventListener('click', () => select(btn.dataset.part)));
}

// What of a suggestion is collected, planned in own tours and still left, with an estimate for the rest
function restHtml(tour) {
    if (isDone(tour) || tour.single) return '';
    const owners = plannedStampOwners();
    const f = restFigures(tour, owners);
    if (!f.reduced) return '';

    const names = numbers => numbers.map(n => `<span class="mono">${n}</span> ${escapeHtml(stampsByNumber.get(n)?.name || '')}`).join(', ');
    const got = tour.stamps.filter(n => collected.has(n));
    const byOwner = new Map();
    tour.stamps.filter(n => !collected.has(n) && owners.has(n)).forEach(n => {
        const owner = owners.get(n);
        byOwner.set(owner, [...(byOwner.get(owner) || []), n]);
    });

    const items = [
        got.length && `<li><b>Gesammelt:</b> ${names(got)}</li>`,
        ...[...byOwner].map(([owner, numbers]) =>
            `<li><b>Verplant</b> in <button type="button" class="part-link" data-own="${owner.id}">„${escapeHtml(owner.name)}“</button>: ${names(numbers)}</li>`),
        f.empty
            ? '<li><b>Rest:</b> keiner, alle offenen Stempel sind in eigenen Touren verplant.</li>'
            : `<li><b>Rest:</b> ${names(f.rest)}${f.rest.length > 1
                ? ` <span class="mono">· ~${fmt1(f.km)} km · ≥${f.ascent} Hm</span> ${levelHtml(tour, f)}`
                : ''}</li>`
    ].filter(Boolean).join('');

    const hint = f.empty ? ''
        : f.rest.length === 1
            ? 'Nur noch ein Stempel offen: am besten als Abstecher auf einer anderen Tour mitnehmen.'
            : 'Die Rest-Werte sind geschätzt (Luftlinie × 1,4, Hm nur von Stempel zu Stempel). Auf der Karte ist die Rest-Runde gepunktet. „Rest auf Wanderwege legen“ berechnet sie auf echten Wegen und speichert sie als eigene Tour.';
    return `<div class="rest-box">
        <b>Stand dieses ${tour.parent ? 'Teils' : 'Vorschlags'}</b>
        <ul>${items}</ul>
        ${hint ? `<p class="hint">${hint}</p>` : ''}
        ${f.rest.length > 1 ? '<div class="detail-actions"><button type="button" class="calc-route-btn" id="restRoute">Rest auf Wanderwege legen</button></div>' : ''}
    </div>`;
}

function tipsHtml(tour) {
    return `<ul class="tips">${tourTags(tour).map(g => `<li><b>${escapeHtml(g.label)}:</b> ${escapeHtml(g.hint)}</li>`).join('')}</ul>`;
}

// Stamps in walking order, each with its own "gestempelt" checkbox
function stopListHtml(stamps, showSuggestion = false) {
    if (!stamps.length) return '<p class="hint">Keine Stempel an dieser Tour.</p>';
    return `<ol class="stop-list">${stamps.map((s, i) => {
        const suggestion = showSuggestion && plan.tours.find(t => t.stamps.includes(s.number));
        return `
            <li class="stop-item${collected.has(s.number) ? ' collected' : ''}">
                <span class="stop-number">${i + 1}</span>
                <span class="stop-name">${escapeHtml(s.name)}</span>
                <span class="stop-id">${s.id}${s.elevation ? ` · ${s.elevation} m` : ''}${suggestion ? ` · Vorschlag ${suggestion.id}` : ''}</span>
                <label class="stamp-check" title="Gestempelt"><input type="checkbox" class="stamp-done" data-stamp="${s.number}"${collected.has(s.number) ? ' checked' : ''} aria-label="${escapeHtml(`${s.id} ${s.name} gestempelt`)}"></label>
            </li>`;
    }).join('')}
        </ol>`;
}

function komootBoxHtml(tour) {
    return `<div class="komoot-box">
            <b>Komoot</b>
            ${komootHtml(tour)}
            <form class="komoot-add" id="komootForm">
                <input type="text" id="komootInput" placeholder="komoot.com/tour/… oder Tour-ID" aria-label="Komoot-Link hinzufügen" autocomplete="off">
                <button type="submit" class="calc-route-btn">Verlinken</button>
            </form>
        </div>`;
}

// Handlers shared by suggestions, parts and own tours
function bindDetailCommon(detail, tour, { gpx, fileName, compareName }) {
    el('tourGpx').addEventListener('click', () => downloadGPX(gpx(), fileName));
    // app.js owns the comparison view; hand the route over without importing it here
    el('tourCompare').addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('hwn:compare-route', { detail: { gpx: gpx(), name: compareName } }));
    });
    el('tourClear').addEventListener('click', () => {
        selectedId = null;
        render();
        fitTo(shownUnits().filter(t => !regionFilter || t.region === regionFilter));
    });

    const doneToggle = el('tourDoneToggle');
    syncDoneCheckbox(doneToggle, tour);
    doneToggle.addEventListener('change', e => {
        setTourCollected(tour, e.target.checked);
        renderList();
        render();
    });
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

function renderOwnDetail(detail, tour) {
    const stamps = tourStamps(tour);
    const f = tourFigures(tour);
    const track = tracks.get(tour.id);
    const error = trackErrors.get(tour.id);
    const walked = isDone(tour);
    detail.style.setProperty('--c', OWN_COLOR);

    const message = detailMessage?.tourId === tour.id && !detailMessage.komoot
        ? `<p class="hint ${detailMessage.isError ? 'track-warning' : 'track-ok'}">${escapeHtml(detailMessage.text)}</p>` : '';
    const confirmDelete = ownDeleteId === tour.id
        ? `<div class="own-confirm">
                <p class="hint track-warning">„${escapeHtml(tour.name)}“ wirklich löschen? Die gesammelten Stempel bleiben erhalten.</p>
                <div class="detail-actions">
                    <button type="button" class="selection-btn primary" id="ownDeleteYes">Ja, löschen</button>
                    <button type="button" class="detail-clear" id="ownDeleteNo">Abbrechen</button>
                </div>
            </div>`
        : '';

    detail.innerHTML = `
        <span class="region-tag">Eigene Tour</span>
        <h3>${escapeHtml(tour.name)} <span class="level ${walked ? 'lv-leicht' : 'lv-mittel'}">${walked ? '✓ gelaufen' : 'geplant'}</span></h3>
        <div class="tour-meta mono">${track
            ? `<span>${fmt1(f.km)} km</span><span>ca. ${fmt1(f.hours)} Std.</span><span>${f.realAscent ? '' : 'mind. '}${f.ascent} Hm</span>${levelHtml(tour)}<span>${f.minEle}–${f.maxEle} m ü. NN</span>`
            : ''}<span>${stamps.length} Stempel</span></div>
        ${tipsHtml(tour)}
        ${stopListHtml(stamps, true)}
        <div class="done-box">
            <label><input type="checkbox" id="tourDoneToggle"> Gelaufen</label>
            <span class="hint">Markiert die Tour als gelaufen und sammelt ihre Stempel. Ohne Haken werden diese Stempel wieder entfernt, außer eine andere gelaufene eigene Tour enthält sie.</span>
        </div>
        <div class="track-box">
            <p class="hint track-source"><b>${track && isSuggestedTrack(track) ? 'Eigene Tour, Weg von OpenRouteService (ungeprüft)' : 'Eigene Tour'}:</b> <span class="mono">${escapeHtml(tour.record.fileName || 'GPX')}</span> · im Browser gespeichert, wird mit exportiert</p>
            ${error ? `<p class="hint track-warning">⚠ ${escapeHtml(error)}</p>` : ''}
            ${message}
            <div class="detail-actions">
                <button type="button" class="calc-route-btn" id="ownEdit">Bearbeiten</button>
                <button type="button" class="detail-clear" id="ownDelete">Löschen</button>
            </div>
            ${confirmDelete}
        </div>
        ${komootBoxHtml(tour)}
        <div class="detail-actions">
            <button type="button" class="selection-btn primary" id="tourGpx">GPX-Track herunterladen</button>
            <button type="button" class="calc-route-btn" id="tourCompare" title="Track im Routenabgleich gegen alle Stempel prüfen">Im Routenabgleich prüfen</button>
            <button type="button" class="detail-clear" id="tourClear">Auswahl aufheben</button>
        </div>`;

    bindDetailCommon(detail, tour, {
        gpx: () => tour.record.gpx,
        fileName: tour.name.replace(/[^\wäöüÄÖÜß-]+/g, '_').slice(0, 60) || 'eigene-tour',
        compareName: unitLabel(tour)
    });
    el('ownEdit').addEventListener('click', () => startOwnDraft(tour.record.gpx, tour.record.fileName, tour.record));
    el('ownDelete').addEventListener('click', () => {
        ownDeleteId = tour.id;
        render();
    });
    el('ownDeleteNo')?.addEventListener('click', () => {
        ownDeleteId = null;
        render();
    });
    el('ownDeleteYes')?.addEventListener('click', () => removeOwnTour(tour));
}

// "2026-09-26_3310815718_Ilsetal.gpx" (Komoot export) -> "Ilsetal"
function nameFromFile(fileName) {
    return fileName.replace(/\.gpx$/i, '').replace(/^\d{4}-\d{2}-\d{2}_\d{5,}_/, '').replace(/[_]+/g, ' ').trim();
}

/**
 * Open the own tour form for a GPX: detects the stamps along the track.
 * @param {Object|null} existing - record when editing an own tour
 */
function startOwnDraft(gpx, fileName, existing = null) {
    const latLngs = analyzeTrack(gpx, []).latLngs;
    const along = stampsAlongTrack(gpx, [...stampsByNumber.values()]);
    const detected = along.filter(a => a.distance <= STAMP_ON_TRACK_METERS).map(a => a.number);
    const keepStamps = existing && existing.gpx === gpx;
    ownDraft = {
        id: existing?.id || null,
        name: existing?.name || gpxName(gpx) || nameFromFile(fileName || '') || 'Eigene Tour',
        gpx,
        fileName: fileName || '',
        latLngs,
        along,
        chosen: new Set(keepStamps ? existing.stamps : detected),
        walked: existing?.status === 'walked',
        message: null
    };
    ownDeleteId = null;
    render();
    const pts = latLngs.flat();
    if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 14 });
    el('tourMapGrid').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * Open the own tour form from outside (Routenabgleich). The stamps along the track are detected
 * as usual; the given stamps (e.g. selected in the comparison) are preselected in addition.
 * @param {Object} route - {gpx, fileName, name, stamps: [stamp numbers]}
 */
export function openOwnTourDraft({ gpx, fileName = '', name = '', stamps = [] }) {
    if (!plan) throw new Error('Tourenplan ist noch nicht geladen.');
    startOwnDraft(gpx, fileName);
    if (name) ownDraft.name = name;
    stamps.filter(n => stampsByNumber.has(n)).forEach(n => ownDraft.chosen.add(n));
    render();
}

function renderOwnForm(detail) {
    const d = ownDraft;
    detail.style.setProperty('--c', OWN_COLOR);
    const km = d.latLngs.flat().reduce((a, p, i, all) => i ? a + distanceMeters(all[i - 1][0], all[i - 1][1], p[0], p[1]) : 0, 0) / 1000;
    // Detected stamps plus manually added ones, in the order the track passes them
    const listed = d.along.filter(a => a.distance <= STAMP_ON_TRACK_METERS || d.chosen.has(a.number));
    const items = listed.map(a => {
        const s = stampsByNumber.get(a.number);
        const suggestion = plan.tours.find(t => t.stamps.includes(a.number));
        return `<li><label>
            <input type="checkbox" class="own-stamp" data-stamp="${a.number}"${d.chosen.has(a.number) ? ' checked' : ''}>
            <span class="mono">${s.number}</span> ${escapeHtml(s.name)}
            <span class="hint">${Math.round(a.distance)} m vom Track${suggestion ? ` · Vorschlag ${suggestion.id}` : ''}${collected.has(a.number) ? ' · schon gestempelt' : ''}</span>
        </label></li>`;
    }).join('');

    detail.innerHTML = `
        <span class="region-tag">Eigene Tour</span>
        <h3>${d.id ? 'Eigene Tour bearbeiten' : 'Eigene Tour anlegen'}</h3>
        <p class="hint">GPX: <span class="mono">${escapeHtml(d.fileName || 'ohne Dateiname')}</span> · ${fmt1(km)} km. Die Karte zeigt den Track gepunktet.</p>
        <form class="own-form" id="ownForm">
            <label class="field-label" for="ownName">Name</label>
            <input type="text" id="ownName" maxlength="120" required value="${escapeHtml(d.name)}">
            <fieldset class="own-stamps">
                <legend>Stempel dieser Tour</legend>
                <p class="hint">Erkannt werden alle Stempel bis ${STAMP_ON_TRACK_METERS} m vom Track. Nimm den Haken weg, wenn du einen davon nicht mitnimmst.</p>
                ${items ? `<ul>${items}</ul>` : '<p class="hint">Kein Stempel liegt am Track.</p>'}
                <div class="own-add">
                    <input type="text" id="ownStampNumber" inputmode="numeric" placeholder="Nummer, z. B. 131" aria-label="Stempel per Nummer hinzufügen" autocomplete="off">
                    <button type="button" class="calc-route-btn" id="ownStampAdd">Stempel hinzufügen</button>
                </div>
            </fieldset>
            ${d.id ? '' : `<label class="own-walked"><input type="checkbox" id="ownWalked"${d.walked ? ' checked' : ''}> Schon gelaufen (sammelt die Stempel)</label>`}
            ${d.message ? `<p class="hint ${d.message.isError ? 'track-warning' : 'track-ok'}">${escapeHtml(d.message.text)}</p>` : ''}
            <div class="detail-actions">
                <button type="submit" class="selection-btn primary">Speichern</button>
                <button type="button" class="calc-route-btn" id="ownPickGpx">Andere GPX-Datei</button>
                <button type="button" class="detail-clear" id="ownCancel">Abbrechen</button>
            </div>
        </form>`;

    el('ownName').addEventListener('input', e => { d.name = e.target.value; });
    el('ownWalked')?.addEventListener('change', e => { d.walked = e.target.checked; });
    detail.querySelectorAll('.own-stamp').forEach(cb => cb.addEventListener('change', () => {
        const n = Number(cb.dataset.stamp);
        cb.checked ? d.chosen.add(n) : d.chosen.delete(n);
    }));
    const addStamp = () => {
        const n = Number(el('ownStampNumber').value.trim());
        const a = d.along.find(x => x.number === n);
        if (!a) d.message = { text: `Stempel ${el('ownStampNumber').value.trim() || '?'} gibt es nicht.`, isError: true };
        else if (d.chosen.has(n)) d.message = { text: `Stempel ${n} ist schon dabei.`, isError: true };
        else {
            d.chosen.add(n);
            d.message = { text: `Stempel ${n} hinzugefügt (${Math.round(a.distance)} m vom Track).`, isError: false };
        }
        render();
        el('ownStampNumber')?.focus();
    };
    el('ownStampAdd').addEventListener('click', addStamp);
    el('ownStampNumber').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addStamp();
        }
    });
    el('ownPickGpx').addEventListener('click', () => el('ownFile').click());
    el('ownCancel').addEventListener('click', () => {
        ownDraft = null;
        render();
    });
    el('ownForm').addEventListener('submit', e => {
        e.preventDefault();
        saveOwnDraft();
    });
}

async function saveOwnDraft() {
    const d = ownDraft;
    const name = d.name.trim();
    if (!name) {
        d.message = { text: 'Bitte gib der Tour einen Namen.', isError: true };
        render();
        return;
    }
    const existing = ownTours.find(r => r.id === d.id);
    const record = {
        id: d.id || `own-${Date.now()}`,
        name: name.slice(0, 120),
        gpx: d.gpx,
        fileName: d.fileName,
        stamps: d.along.filter(a => d.chosen.has(a.number)).map(a => a.number),
        status: existing ? existing.status : (d.walked ? 'walked' : 'planned'),
        createdAt: existing?.createdAt || new Date().toISOString()
    };
    try {
        await saveOwnTour(record);
    } catch {
        d.message = { text: 'Speichern fehlgeschlagen.', isError: true };
        render();
        return;
    }
    // A walked tour collects its (possibly new) stamps
    if (record.status === 'walked') {
        record.stamps.forEach(n => collected.add(n));
        saveCollected();
    }
    ownDraft = null;
    const komootUrl = komootUrlFromFilename(record.fileName);
    const linked = komootUrl && !(komootLinks[record.id] || []).some(l => l.url === komootUrl);
    if (linked) {
        komootLinks[record.id] = [...(komootLinks[record.id] || []), { url: komootUrl, name: '' }];
        saveKomootLinks();
    }
    detailMessage = { tourId: record.id, text: (existing ? 'Änderungen gespeichert.' : 'Eigene Tour gespeichert.') + (linked ? ' Komoot-Tour verlinkt.' : ''), isError: false };
    setOwnTours([...ownTours.filter(r => r.id !== record.id), record]);
    select(record.id);
}

async function removeOwnTour(tour) {
    try {
        await deleteOwnTour(tour.id);
    } catch {
        detailMessage = { tourId: tour.id, text: 'Löschen fehlgeschlagen.', isError: true };
        render();
        return;
    }
    ownDeleteId = null;
    delete komootLinks[tour.id];
    saveKomootLinks();
    selectedId = null;
    setOwnTours(ownTours.filter(r => r.id !== tour.id));
    setOwnStatus(`„${tour.name}“ gelöscht.`);
}

function setOwnStatus(msg, isError = false) {
    const status = el('ownStatus');
    status.textContent = msg;
    status.classList.toggle('error', isError);
}

function initOwnTours() {
    const input = el('ownFile');
    el('ownAdd').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        if (!file) return;
        try {
            const gpx = await file.text();
            // Editing keeps the tour's id and name; a new file re-detects the stamps
            const existing = ownDraft?.id ? ownTours.find(r => r.id === ownDraft.id) : null;
            const name = ownDraft?.id ? ownDraft.name : null;
            startOwnDraft(gpx, file.name, existing);
            if (name) ownDraft.name = name;
            setOwnStatus('');
            render();
        } catch (e) {
            setOwnStatus(`GPX nicht übernommen: ${e.message || 'Datei unlesbar.'}`, true);
        }
    });
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

// Store a new own tour (from the rest of a suggestion or a copy of it) and open it
async function createOwnTour(record, message) {
    await saveOwnTour(record);
    detailMessage = { tourId: record.id, text: message, isError: false };
    setOwnTours([...ownTours, record]);
    select(record.id);
}

// Route only the remaining stamps of a suggestion; the result becomes a planned own tour
async function routeRest(tour, button) {
    const setMessage = (text, isError) => {
        detailMessage = { tourId: tour.id, text, isError };
        render();
    };
    if (!hasApiKey()) {
        setMessage('Dafür brauchst du einen OpenRouteService-API-Schlüssel. Hinterlege ihn im Tab Routenabgleich unter den API-Einstellungen.', true);
        return;
    }
    const rest = restStamps(tour);
    if (rest.length < 2) return;

    button.disabled = true;
    button.textContent = 'Berechne …';
    const stamps = rest.map(n => stampsByNumber.get(n));
    const result = await calculateHikingTrack([...stamps, stamps[0]]);
    if (result.error) {
        setMessage(`Rest-Runde nicht berechnet: ${result.error}`, true);
        return;
    }
    const name = `${tour.id} – Rest`;
    try {
        await createOwnTour({
            id: `own-${Date.now()}`,
            name,
            gpx: coordinatesToGPX(`OpenRouteService – ${name}`, result.coordinates),
            fileName: '',
            stamps: rest,
            status: 'planned',
            createdAt: new Date().toISOString()
        }, `Rest-Runde von ${unitLabel(tour)} als eigene Tour gespeichert (geplant). Prüfe sie auf der Karte, ORS kennt nicht jeden Pfad.`);
    } catch (e) {
        setMessage(`Rest-Runde nicht gespeichert: ${e.message || 'Speichern fehlgeschlagen.'}`, true);
    }
}

// Copy a suggestion with its track (and Komoot links) into an own tour that can then be edited
async function adoptSuggestion(tour, button) {
    const track = tracks.get(tour.id);
    if (!track) return;
    button.disabled = true;
    const id = `own-${Date.now()}`;
    const links = tourKomootLinks(tour).map(({ url, name }) => ({ url, name }));
    try {
        await createOwnTour({
            id,
            name: `${tour.id} – eigene Variante`,
            gpx: track.gpx,
            fileName: track.name,
            stamps: [...tour.stamps],
            status: 'planned',
            createdAt: new Date().toISOString()
        }, `${unitLabel(tour)} als eigene Tour übernommen. Mit „Bearbeiten“ passt du Name, Stempel oder GPX an.`);
        if (links.length) {
            komootLinks[id] = links;
            saveKomootLinks();
            renderList();
            render();
        }
    } catch (e) {
        detailMessage = { tourId: tour.id, text: `Nicht übernommen: ${e.message || 'Speichern fehlgeschlagen.'}`, isError: true };
        render();
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
        variants,
        ownTours
    }, `hwn-fortschritt-${today}.json`);
    const n = Object.keys(exportedTracks).length;
    const extras = [n && `${n} GPX-Track${n > 1 ? 's' : ''}`, ownTours.length && `${ownTours.length} eigenen ${ownTours.length > 1 ? 'Touren' : 'Tour'}`].filter(Boolean);
    setTransferStatus(`Fortschritt exportiert${extras.length ? ` (mit ${extras.join(' und ')})` : ''}.`);
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
    // Own tours: only replaced when the file has them (exports before own tours keep the browser's)
    let ownCount = null;
    let ownRecords = ownTours;
    if (Array.isArray(data.ownTours)) {
        ownRecords = data.ownTours.map(sanitizeOwnRecord).filter(Boolean)
            .filter((r, i, all) => all.findIndex(x => x.id === r.id) === i);
        await clearOwnTours();
        for (const record of ownRecords) await saveOwnTour(record);
        ownCount = ownRecords.length;
    }
    // Same for Komoot links: only replaced when the file has them
    if (data.komoot && typeof data.komoot === 'object') {
        const ownIds = new Set(ownRecords.map(r => r.id));
        komootLinks = sanitizeKomootLinks(data.komoot, id => tourIds.has(id) || ownIds.has(id));
        saveKomootLinks();
    }
    // Same for the chosen variants of split tours
    if (data.variants && typeof data.variants === 'object') {
        variants = sanitizeVariants(data.variants);
        saveVariants();
    }
    ownDraft = null;
    setOwnTours(ownRecords);

    const doneCount = plan.tours.filter(isDone).length;
    let msg = `Importiert: ${doneCount} ${doneCount === 1 ? 'Vorschlag' : 'Vorschläge'} erledigt, ${collected.size} Stempel gesammelt`;
    if (trackCount !== null) msg += `, ${trackCount} GPX-Track${trackCount === 1 ? '' : 's'}`;
    if (ownCount !== null) msg += `, ${ownCount} eigene ${ownCount === 1 ? 'Tour' : 'Touren'}`;
    msg += '.';
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
