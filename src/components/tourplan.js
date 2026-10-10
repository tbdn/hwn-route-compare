// Tourenplan: groups of stamps ("Gruppen") that fit into one day, covering all stamps, grouped by region.
// A group is no route: the map shows a straight-line sketch until a real track is planned (e.g. in Komoot,
// "In Komoot planen") and stored as project file or browser upload.
// Has its own Leaflet map so it doesn't interfere with the route comparison map.
// Progress is stored per stamp; a tour counts as done when all of its stamps are collected.
// Long tours can have two part tours ("parts" in tours.json); each tour is shown either whole or in parts.
// Own tours (GPX + detected stamps, planned or walked) are stored in the browser next to the suggestions.

import { generateGPX, downloadGPX } from "../utils/optimize.js";
import {
    analyzeTrack, loadProjectTracks, loadUploadedTracks, saveUploadedTrack,
    deleteUploadedTrack, clearUploadedTracks, STAMP_ON_TRACK_METERS,
    loadOwnTours, saveOwnTour, deleteOwnTour, clearOwnTours, stampsAlongTrack, gpxName, reviewTrack, trackOrigin, trackOverlap
} from "../utils/tracks.js";
import { distanceMeters } from "../utils/geo.js";
import { loadBadges, badgeProgress } from "../utils/badges.js";

const HARZ_CENTER = [51.72, 10.75];
const COLLECTED_STORAGE = 'hwn-stamps-collected';
// Tour-based progress before format v3, only read once for the migration
const LEGACY_DONE_STORAGE = 'hwn-tours-done';
const LEGACY_EXTRA_STORAGE = 'hwn-stamps-extra';
const KOMOOT_STORAGE = 'hwn-komoot-links';
const VARIANT_STORAGE = 'hwn-tour-variants';
const PROGRESS_FORMAT = 'hwn-tourenplan-progress';
const DATES_STORAGE = 'hwn-stamp-dates';              // {number: 'YYYY-MM-DD'} when a stamp was collected
const BACKUP_STORAGE = 'hwn-last-backup';             // {at, stamps} of the last export or import
const CHANGES_STORAGE = 'hwn-changes-since-backup';   // number of progress changes since then
const SNOOZE_STORAGE = 'hwn-backup-snooze';           // ISO time until which the reminder stays quiet
const PERSIST_STORAGE = 'hwn-persist-requested';      // navigator.storage.persist() was asked once
const BACKUP_SNOOZE_DAYS = 7;
const BACKUP_DUE_DAYS = 14;
const BACKUP_DUE_CHANGES = 10;
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
// Filter chip for suggestions with something to check
const REVIEW_FILTER = 'review';
const REVIEW_COLOR = '#C26A00';
// Filter chip for what is planned: open units with a Komoot (or other) track and planned own tours
const PLANNED_FILTER = 'planned';
const PLANNED_COLOR = '#2E6B8A';
// Filters by state rather than region
const STATE_FILTERS = new Set([REVIEW_FILTER, PLANNED_FILTER]);
// When an OpenRouteService track is worth checking (e.g. in Komoot)
const REVIEW_RULES = {
    legFactor: 3,        // a leg between two stamps is this many times the straight line ...
    legExtraKm: 1,       // ... and at least this much longer
    backtrackShare: 0.45, // this share of the track runs back on the same path
    lengthFactor: 1.3,   // the whole track is this many times the estimate ...
    lengthExtraKm: 2,    // ... and at least this much longer
    partsShare: 0.85     // both part tracks together are at most this share of the whole track
};

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
let badges = null;                // badges.json (levels for "nächste Stufe"), null when missing
let collected = new Set();        // stamp numbers; the only source of progress
let stampDates = new Map();       // stamp number -> 'YYYY-MM-DD' (local date); collected stamps may have none
let variants = {};                // tourId -> 'parts' when a tour is walked as its part tours
let units = [];                   // every walkable tour: suggestions, their part tours, own tours
const unitById = new Map();
let ownTours = [];                // own tour records as stored: {id, name, gpx, fileName, stamps, status, createdAt}
let ownDraft = null;              // own tour being created or edited (form in the detail panel)
let ownDeleteId = null;           // own tour waiting for the delete confirmation
const reviews = new Map();        // unit id -> [{kind, text, leg?, points?}] things to check on its track or layout
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
let reviewLayer = null;           // detour legs of the selected suggestion
let labelLayer = null;
let endpointLayer = null;
let draftLine = null;             // preview of the GPX in the own tour form

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

const fmt1 = n => n.toFixed(1).replace('.', ',');
const color = code => code === OWN_REGION ? OWN_COLOR : code === REVIEW_FILTER ? REVIEW_COLOR : code === PLANNED_FILTER ? PLANNED_COLOR
    : REGION_COLORS[code] || '#3D3563';

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
const unitLabel = unit => unit.own ? `Eigene Tour „${unit.name}“` : unit.parent ? `Teil ${unit.id}` : `Gruppe ${unit.id}`;

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
        ...(r.status === 'walked' && isValidDate(r.walkedAt) ? { walkedAt: r.walkedAt } : {}),
        createdAt: r.createdAt ? String(r.createdAt) : new Date().toISOString()
    };
}

// Replace the own tours (after loading, saving, deleting or importing) and redraw everything
function setOwnTours(records) {
    ownTours = records;
    const before = ownUnits().map(u => u.id);
    buildUnits();
    if (!map) {
        refreshTracks();
        return;
    }
    before.filter(id => !unitById.has(id)).forEach(removeUnitLines);
    units.filter(u => !loopLines.has(u.id)).forEach(addUnitLines);
    if (selectedId && !unitById.has(selectedId)) selectedId = null;
    if (regionFilter === OWN_REGION && !ownTours.length) regionFilter = null;
    refreshTracks();
}

// The variant chosen in the browser, otherwise the default from tours.json (`defaultVariant: "parts"`)
function usesParts(tour) {
    if (!tour.parts?.length) return false;
    return (variants[tour.id] || tour.defaultVariant || 'whole') === 'parts';
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
        if ((v === 'parts' || v === 'whole') && unitById.get(id)?.parts?.length) result[id] = v;
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

// Only a choice that differs from the tour's default is stored
function setVariant(tour, useParts) {
    const variant = useParts ? 'parts' : 'whole';
    if (variant === (tour.defaultVariant || 'whole')) delete variants[tour.id];
    else variants[tour.id] = variant;
    saveVariants();
    updateLines();
    renderList();
    render();
    notifyChange();
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

// Komoot planner with the stamps as waypoints, closed to a loop (same URL format as Komoot's own planner links)
function komootPlanUrl(stamps) {
    const lat = stamps.reduce((a, s) => a + s.lat, 0) / stamps.length;
    const lon = stamps.reduce((a, s) => a + s.lon, 0) / stamps.length;
    const loop = stamps.length > 1 ? [...stamps, stamps[0]] : stamps;
    const points = loop.map((s, i) => `p[${i}][loc]=${s.lat.toFixed(6)},${s.lon.toFixed(6)}&p[${i}][name]=${encodeURIComponent(s.name)}`);
    return `https://www.komoot.com/de-de/plan/@${lat.toFixed(5)},${lon.toFixed(5)},13z?sport=hike&${points.join('&')}`;
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
    try {
        localStorage.setItem(DATES_STORAGE, JSON.stringify(datesObject()));
    } catch {
        // ignore
    }
    writeStorage(CHANGES_STORAGE, String(changesSinceBackup() + 1));
    if (collected.size) requestPersistentStorage();
    renderBackupHint();
    notifyChange();
}

function readStorage(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key, value) {
    try {
        value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
    } catch {
        // ignore
    }
}

function changesSinceBackup() {
    return Math.max(0, parseInt(readStorage(CHANGES_STORAGE), 10) || 0);
}

function lastBackup() {
    try {
        const b = JSON.parse(readStorage(BACKUP_STORAGE));
        return b && !Number.isNaN(Date.parse(b.at)) ? b : null;
    } catch {
        return null;
    }
}

// Browsers may clear site data under storage pressure (or Safari after a week without a visit);
// a persistent grant prevents that. Asked once, on the first collected stamp.
let storagePersisted = null;      // true/false once known
function requestPersistentStorage() {
    const storage = globalThis.navigator?.storage;
    if (!storage?.persist || readStorage(PERSIST_STORAGE)) return;
    writeStorage(PERSIST_STORAGE, new Date().toISOString());
    storage.persist().then(granted => {
        storagePersisted = granted;
        renderBackupHint();
    }).catch(() => {});
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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = d => typeof d === 'string' && DATE_PATTERN.test(d) && !Number.isNaN(Date.parse(d));

/** Today as local 'YYYY-MM-DD' (toISOString() would be UTC) */
export function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The only place that collects or removes stamps: a new stamp gets the date, one already collected
// keeps its date, a removed stamp loses it. Saving is up to the caller.
function collectStamps(numbers, on, date = today()) {
    numbers.forEach(n => {
        if (on) {
            if (!collected.has(n) && isValidDate(date)) stampDates.set(n, date);
            collected.add(n);
        } else {
            collected.delete(n);
            stampDates.delete(n);
        }
    });
}

function loadDates() {
    let data = {};
    try {
        data = JSON.parse(localStorage.getItem(DATES_STORAGE) || '{}') || {};
    } catch {
        // storage unavailable or broken: no dates
    }
    return sanitizeDates(data);
}

// Dates only for collected stamps and in the right format
function sanitizeDates(data) {
    if (!data || typeof data !== 'object') return new Map();
    return new Map(Object.entries(data).map(([n, d]) => [Number(n), d]).filter(([n, d]) => collected.has(n) && isValidDate(d)));
}

const datesObject = () => Object.fromEntries([...stampDates].sort((a, b) => a[0] - b[0]).map(([n, d]) => [String(n), d]));

// The tour checkbox collects or removes all of its stamps (each stamp belongs to one suggestion)
function setTourCollected(tour, on) {
    if (tour.own) {
        setOwnWalked(tour, on);
        return;
    }
    collectStamps(tour.stamps, on);
    saveCollected();
}

// Walking an own tour collects its stamps; undoing it removes them again,
// except those another walked own tour covers as well
function setOwnWalked(unit, on) {
    unit.record.status = on ? 'walked' : 'planned';
    if (on) {
        unit.record.walkedAt = today();
        collectStamps(unit.stamps, true);
    } else {
        delete unit.record.walkedAt;
        const keep = new Set(ownUnits().filter(u => u !== unit && isDone(u)).flatMap(u => u.stamps));
        collectStamps(unit.stamps.filter(n => !keep.has(n)), false);
    }
    saveCollected();
    saveOwnTour(unit.record).catch(() => {
        detailMessage = { tourId: unit.id, text: 'Status konnte nicht gespeichert werden.', isError: true };
        render();
    });
}

function setStampCollected(number, on) {
    collectStamps([number], on);
    saveCollected();
}

// Open stamps that a planned (not yet walked) own tour will cover, with the tour that covers them.
// Used for the rest of suggestions (no stamp counted twice), whatever the own tour's track is;
// whether a stamp is really "verplant" depends on the track, see stampPlanning().
function ownTourStampOwners() {
    const owners = new Map();
    ownUnits().filter(u => !isDone(u)).forEach(u => u.stamps.forEach(n => {
        if (!collected.has(n) && !owners.has(n)) owners.set(n, u);
    }));
    return owners;
}

// Tracks from Komoot or another service are real plans; OpenRouteService tracks are unchecked suggestions,
// and straight lines exported by the app are no way at all
const CHECKED_ORIGINS = new Set(['komoot', 'external']);
const ORIGIN_LABELS = { ors: 'Routenvorschlag (OpenRouteService, ungeprüft)', app: 'Luftlinie aus der App', komoot: 'Komoot-Track', external: 'Track aus anderem Dienst' };
const hasCheckedTrack = unit => CHECKED_ORIGINS.has(tracks.get(unit.id)?.origin);

/**
 * Planning state of every open stamp:
 * - 'planned': an open unit (chosen variant or planned own tour) has a Komoot or other checked track
 *   that passes the stamp
 * - 'own-unchecked': in a planned own tour whose track is from OpenRouteService or a straight line
 * - 'suggested': only in a suggestion with an OpenRouteService track
 * @returns {Map<number, {status, unit, origin}>}
 */
function stampPlanningMap() {
    const result = new Map();
    const set = (n, status, unit) => {
        if (!collected.has(n) && !result.has(n)) result.set(n, { status, unit, origin: tracks.get(unit.id)?.origin || null });
    };
    const open = shownUnits().filter(u => !isDone(u));
    open.filter(hasCheckedTrack).forEach(unit => {
        const missed = new Set(tracks.get(unit.id).missed.map(m => m.number));
        unit.stamps.filter(n => !missed.has(n)).forEach(n => set(n, 'planned', unit));
    });
    open.filter(u => u.own).forEach(unit => unit.stamps.forEach(n => set(n, 'own-unchecked', unit)));
    open.filter(u => !u.own && tracks.get(u.id)?.origin === 'ors').forEach(unit => unit.stamps.forEach(n => set(n, 'suggested', unit)));
    return result;
}

/** Planning of all open stamps for the stamp page: number -> {status, unitId, name, origin, originLabel} */
export function stampPlanning() {
    return new Map([...stampPlanningMap()].map(([n, p]) => [n, {
        status: p.status, unitId: p.unit.id, name: unitLabel(p.unit), origin: p.origin, originLabel: ORIGIN_LABELS[p.origin] || ''
    }]));
}

// When a route from elsewhere (e.g. Komoot) fits a suggestion
const MATCH_RULES = {
    share: 0.8,          // this share of both tracks runs on the same way
    kmFactor: 0.2,       // without a track to compare: the length differs at most this much from the estimate
    nearStampMeters: 300, // a suggestion without stamps on the route is still shown with a stamp this close ...
    sharedKm: 0.5        // ... or this much way in common
};
const MATCH_ORDER = { fits: 0, covers: 1, inside: 2, differs: 3, partial: 4, nearby: 5 };

// [south, west, north, east] of [[lat, lon], ...], widened by `meters`
function boundsOf(points, meters = 0) {
    const lats = points.map(p => p[0]);
    const lons = points.map(p => p[1]);
    const dLat = meters / 111_000;
    const dLon = dLat / Math.cos(lats[0] * Math.PI / 180);
    return [Math.min(...lats) - dLat, Math.min(...lons) - dLon, Math.max(...lats) + dLat, Math.max(...lons) + dLon];
}
const boundsMeet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * Suggestions and part tours (whatever variant is chosen) near a route, best fit first: those with a stamp
 * on the route, a stamp close to it or some way in common. Compares the stamps, the length and, when the
 * suggestion has a track, the ways.
 * Needs the plan (loadStampProgress) and, for the ways, the tracks (loadPlanTracks).
 * @param {Object} route - {latLngs: [[[lat, lon], ...], ...] per segment, km}
 * @returns {Array<Object>} - {id, label, color, verdict: 'fits'|'covers'|'inside'|'differs'|'partial'|'nearby',
 *   hit: [number], missed: [{number, distance}], km, real, routeKm, origin, originLabel,
 *   suggestionShare, routeShare, sharedKm, latLngs, deviations}
 */
export function suggestionMatches(route) {
    if (!plan) return [];
    const points = route.latLngs.flat();
    if (!points.length) return [];
    const routeBounds = boundsOf(points, MATCH_RULES.nearStampMeters);
    const distances = new Map();
    const distanceToRoute = n => {
        if (!distances.has(n)) {
            const s = stampsByNumber.get(n);
            distances.set(n, !s || !boundsMeet(routeBounds, [s.lat, s.lon, s.lat, s.lon])
                ? Infinity
                : Math.min(...points.map(p => distanceMeters(s.lat, s.lon, p[0], p[1]))));
        }
        return distances.get(n);
    };

    return units.filter(u => !u.own).map(unit => {
        const hit = unit.stamps.filter(n => distanceToRoute(n) <= STAMP_ON_TRACK_METERS);
        const missed = unit.stamps.filter(n => !hit.includes(n)).map(number => ({ number, distance: distanceToRoute(number) }));
        const track = tracks.get(unit.id);
        const trackNear = track && boundsMeet(routeBounds, boundsOf(track.latLngs.flat()));
        const stampNear = missed.some(m => m.distance <= MATCH_RULES.nearStampMeters);
        if (!hit.length && !trackNear && !stampNear) return null;

        const f = tourFigures(unit);
        const result = {
            id: unit.id, label: unitLabel(unit), color: unitColor(unit), hit, missed,
            km: f.km, real: f.real, routeKm: route.km,
            origin: track?.origin || null, originLabel: track ? ORIGIN_LABELS[track.origin] : '',
            suggestionShare: null, routeShare: null, sharedKm: 0, latLngs: track?.latLngs || null, deviations: []
        };
        if (track && trackNear) {
            const ofSuggestion = trackOverlap(track.latLngs, route.latLngs);
            const ofRoute = trackOverlap(route.latLngs, track.latLngs);
            result.suggestionShare = ofSuggestion.share;
            result.routeShare = ofRoute.share;
            result.sharedKm = ofRoute.share * route.km;
            result.deviations = ofRoute.deviations;
        } else if (track) {
            result.suggestionShare = 0;
            result.routeShare = 0;
        }
        if (!hit.length && !stampNear && result.sharedKm < MATCH_RULES.sharedKm) return null;
        result.verdict = matchVerdict(result);
        return result;
    }).filter(Boolean).sort((a, b) =>
        MATCH_ORDER[a.verdict] - MATCH_ORDER[b.verdict]
        || b.hit.length / (b.hit.length + b.missed.length) - a.hit.length / (a.hit.length + a.missed.length)
        || (b.routeShare ?? 0) - (a.routeShare ?? 0));
}

// fits = same ways; covers = the route walks the whole suggestion and more; inside = the route is a piece of it;
// differs = same stamps on other ways; partial = only some of the stamps; nearby = no stamp, but close or shared ways
function matchVerdict(m) {
    if (!m.hit.length) return 'nearby';
    if (m.missed.length) return 'partial';
    if (m.suggestionShare === null) {
        return Math.abs(m.routeKm - m.km) <= MATCH_RULES.kmFactor * m.km ? 'fits' : 'differs';
    }
    const suggestionOn = m.suggestionShare >= MATCH_RULES.share;
    const routeOn = m.routeShare >= MATCH_RULES.share;
    if (suggestionOn && routeOn) return 'fits';
    if (suggestionOn) return 'covers';
    if (routeOn) return 'inside';
    return 'differs';
}

// Planned to walk: a planned own tour, or an open suggestion or part (chosen variant) with a checked track
const isPlannedUnit = unit => isShown(unit) && !isDone(unit) && (unit.own || hasCheckedTrack(unit));

const plannedCount = (planning = stampPlanningMap()) => [...planning.values()].filter(p => p.status === 'planned').length;

// What is left of a suggestion: stamps neither collected nor planned in an own tour (in the suggestion's order)
function restStamps(tour, owners = ownTourStampOwners()) {
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
function restFigures(tour, owners = ownTourStampOwners()) {
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
    return `<span class="level lv-${level}" title="${title}">${estimated ? '~' : ''}${level}</span>`
        + ` <span class="effort" title="Leistungs-km = km + Höhenmeter / 100: so anstrengend wie diese Strecke in der Ebene">${estimated ? '~' : ''}${fmt1(effort)} Leistungs-km</span>`;
}

// Season tag from the current highest point first, then the tour's own hints from tours.json
function tourTags(tour) {
    const season = SEASON_TAGS.find(t => tourFigures(tour).maxEle < t.below);
    return [season, ...tour.tags];
}

// Tracks computed by OpenRouteService (older browser uploads, own tours from the comparison) are unchecked
function isSuggestedTrack(track) {
    return track.origin === 'ors';
}

function trackKind(tour, track) {
    const label = ORIGIN_LABELS[track.origin];
    return track.origin === 'komoot' || track.origin === 'external' ? `${label}${isDone(tour) ? ', gelaufen' : ''}` : label;
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
    const tours = selected.length ? selected : shownUnits().filter(matchesFilter);

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

// Plan and progress, shared by the tour plan and the stamp page ("Meine Stempel"); loaded once
let planData = null;
function loadPlanData(stamps) {
    planData ??= (async () => {
        const response = await fetch('./data/tours.json');
        if (!response.ok) {
            throw new Error('Konnte Tourenplan nicht laden');
        }
        plan = await response.json();
        stampsByNumber = new Map(stamps.map(s => [s.number, s]));
        prepareParts();
        buildUnits();
        collected = loadCollected();
        stampDates = loadDates();
        variants = loadVariants();
        // Uploads and own tours come from IndexedDB; they belong to the progress (export) even without the map
        const [uploads, ownRecords, badgeData] = await Promise.all([
            loadUploadedTracks().catch(() => ({})),
            loadOwnTours().catch(() => []),
            loadBadges().catch(() => null)
        ]);
        badges = badgeData;
        uploadedTracks = uploads;
        ownTours = ownRecords.map(sanitizeOwnRecord).filter(Boolean);
        buildUnits();
        komootLinks = sanitizeKomootLinks(loadKomootLinks(), id => unitById.has(id) || OWN_ID.test(id));
        initBackupBar();
    })();
    planData.catch(() => { planData = null; });
    return planData;
}

/**
 * Load the progress without building the tour plan (for the stamp page).
 * Every change of the progress dispatches `hwn:progress-changed` on document.
 * @param {Array} stamps - All stamps in internal format
 */
export async function loadStampProgress(stamps) {
    await loadPlanData(stamps);
}

export const isStampCollected = number => collected.has(number);

/** The suggestion a stamp belongs to: {id, region, regionName, color} or null */
export function suggestionOfStamp(number) {
    const tour = plan?.tours.find(t => t.stamps.includes(number));
    return tour ? { id: tour.id, region: tour.region, regionName: shortRegionName(tour.region), color: color(tour.region) } : null;
}

/**
 * Collect or remove several stamps at once; the tour plan redraws when it is open
 * @param {Array<number>} numbers
 * @param {boolean} on
 * @param {string} date - 'YYYY-MM-DD' for newly collected stamps (default today)
 */
export function setStampsCollected(numbers, on, date = today()) {
    collectStamps(numbers.filter(n => stampsByNumber.has(n)), on, date);
    saveCollected();
    if (initialized && map) render();
}

/** Date a stamp was collected ('YYYY-MM-DD') or null */
export const stampDate = number => stampDates.get(number) || null;

/** Change the date of a collected stamp; null or '' removes it (the stamp stays collected) */
export function setStampDate(number, date) {
    if (!collected.has(number)) return;
    if (isValidDate(date)) stampDates.set(number, date);
    else stampDates.delete(number);
    saveCollected();
}

/** Select a tour in the (already shown) tour plan */
export function showTour(id) {
    if (initialized && map && unitById.has(id)) select(id, true);
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
    try {
        await loadPlanData(stamps);
    } catch (e) {
        initialized = false;
        throw e;
    }

    initTourMap();
    initOwnTours();
    renderChips();
    renderList();
    render();

    // Project tracks load in the background; the straight-line plan is usable meanwhile
    if (projectTrackData) refreshTracks();
    await loadPlanTracks();
}

// Project tracks are loaded once, by the tour plan or the stamp page (for "verplant")
let projectTrackData = null;
export function loadPlanTracks() {
    projectTrackData ??= (async () => {
        projectTracks = await loadProjectTracks(units.filter(u => !u.own).map(u => u.id));
        refreshTracks();
    })();
    return projectTrackData;
}

// Every progress or planning change: the stamp page and the route comparison follow it
function notifyChange() {
    document.dispatchEvent(new CustomEvent('hwn:progress-changed'));
}

// Rebuild the effective track per tour (upload beats project file); draws only when the map exists
function refreshTracks() {
    updateUploadsButton();
    buildTracks();
    notifyChange();
    if (!map) return;
    computeReviews();
    updateLines();
    renderChips();
    renderList();
    render();
}

function buildTracks() {
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
                tracks.set(tour.id, { ...c, origin: trackOrigin(c.gpx), ...analyzeTrack(c.gpx, tourStamps(tour)) });
                break;
            } catch (e) {
                trackErrors.set(tour.id, `${c.name}: ${e.message}`);
            }
        }
    });
}

const stampLabel = n => `${n} ${stampsByNumber.get(n)?.name || ''}`;

/**
 * Things worth checking per suggestion or part: notes from tours.json (`review`), and for
 * OpenRouteService tracks detours between stamps, ways back on the same path, a track much longer
 * than the estimate, and parts that are much shorter than the whole tour.
 * Walked Komoot tracks and own tours are not judged.
 */
function computeReviews() {
    reviews.clear();
    units.filter(u => !u.own).forEach(unit => {
        const reasons = (unit.review || []).map(text => ({ kind: 'note', text }));
        const track = tracks.get(unit.id);

        if (track && isSuggestedTrack(track) && !unit.single) {
            const result = reviewTrack(track.latLngs, tourStamps(unit));
            result.legs
                .filter(l => l.trackKm >= REVIEW_RULES.legFactor * l.lineKm && l.trackKm - l.lineKm >= REVIEW_RULES.legExtraKm)
                .forEach(l => reasons.push({
                    kind: 'detour', leg: l, points: result.points,
                    text: `Umweg von ${stampLabel(l.from)} nach ${stampLabel(l.to)}: ${fmt1(l.trackKm)} km Weg für ${fmt1(l.lineKm)} km Luftlinie (×${fmt1(l.trackKm / l.lineKm)}). Gibt es einen direkteren Weg?`
                }));
            if (result.backtrackShare >= REVIEW_RULES.backtrackShare) {
                reasons.push({
                    kind: 'backtrack',
                    text: `${Math.round(result.backtrackShare * 100)} % der Strecke führen auf demselben Weg zurück. Gibt es eine echte Runde?`
                });
            }
            if (unit.km && track.km >= REVIEW_RULES.lengthFactor * unit.km && track.km - unit.km >= REVIEW_RULES.lengthExtraKm) {
                reasons.push({
                    kind: 'longer',
                    text: `Der Track ist ${fmt1(track.km)} km lang, geschätzt waren ${fmt1(unit.km)} km (×${fmt1(track.km / unit.km)}). OpenRouteService kennt vermutlich nicht jeden Pfad.`
                });
            }
        }

        const whole = tracks.get(unit.id);
        const partTracks = (unit.parts || []).map(p => tracks.get(p.id));
        if (whole && partTracks.length && partTracks.every(Boolean)) {
            const sum = partTracks.reduce((a, t) => a + t.km, 0);
            if (sum <= REVIEW_RULES.partsShare * whole.km) {
                reasons.push({
                    kind: 'parts',
                    text: `In zwei Teilen deutlich kürzer: ${unit.parts.map(p => p.id).join(' + ')} zusammen ${fmt1(sum)} km statt ${fmt1(whole.km)} km, die lange Verbindung zwischen den Teilen fällt weg.`
                });
            }
        }
        if (reasons.length) reviews.set(unit.id, reasons);
    });
}

// Hints that still matter: none for finished tours, the parts hint only while the tour is walked whole
function openReview(unit) {
    if (!unit || unit.own || isDone(unit)) return [];
    return (reviews.get(unit.id) || []).filter(r => r.kind !== 'parts' || !usesParts(unit));
}

// Region chips filter by region; the review chip by open hints
function matchesFilter(unit) {
    if (!regionFilter || !unit) return true;
    if (regionFilter === REVIEW_FILTER) return openReview(unit).length > 0;
    if (regionFilter === PLANNED_FILTER) return isPlannedUnit(unit);
    return unit.region === regionFilter;
}

// Detour legs on the map: of the selection, or of everything to check while the review filter is on
function renderReviewLegs() {
    reviewLayer.clearLayers();
    const selected = shownUnits().filter(isSelected);
    const shown = selected.length ? selected : regionFilter === REVIEW_FILTER ? shownUnits() : [];
    shown.forEach(unit => openReview(unit).filter(r => r.kind === 'detour').forEach(({ leg, points }) => {
        // The closing leg wraps around the end of the track
        const latLngs = leg.endIndex >= leg.startIndex
            ? points.slice(leg.startIndex, leg.endIndex + 1)
            : [...points.slice(leg.startIndex), ...points.slice(0, leg.endIndex + 1)];
        L.polyline(latLngs, { color: REVIEW_COLOR, weight: 9, opacity: 0.45, lineCap: 'round', interactive: false })
            .addTo(reviewLayer);
    }));
}

function reviewHtml(unit) {
    const items = openReview(unit);
    if (!items.length) return '';
    return `<div class="review-box">
        <b><span aria-hidden="true">⚠</span> Zu prüfen</b>
        <ul>${items.map(r => `<li>${escapeHtml(r.text)}</li>`).join('')}</ul>
        <p class="hint">${items.some(r => r.kind === 'detour') ? 'Umweg-Etappen sind auf der Karte orange hinterlegt. ' : ''}Am besten in Komoot nachplanen und den Track als <span class="mono">src/data/tours/${unit.id}.gpx</span> ablegen oder hier hochladen; danach verschwinden die Track-Hinweise von selbst.</p>
    </div>`;
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
    reviewLayer = L.layerGroup().addTo(map);
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
            + (collectedStamps().has(number) ? ' · gestempelt' : tour ? ` · Gruppe ${tour.id}` : '')
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
        b.innerHTML = (code === OWN_REGION || code === PLANNED_FILTER ? '<i></i>' : code === REVIEW_FILTER ? '<span class="review-mark" aria-hidden="true">⚠</span> '
            : code ? `<i></i><span class="mono">${code}</span> ` : '') + `<span class="chip-label">${escapeHtml(label)}</span>`;
        b.addEventListener('click', () => {
            regionFilter = code;
            if (selectedId && !matchesFilter(unitById.get(selectedId))) selectedId = null;
            render();
            fitTo(shownUnits().filter(matchesFilter));
        });
        chips.appendChild(b);
    };
    make(null, 'Alle Regionen');
    make(PLANNED_FILTER, 'Geplant');
    if (reviews.size) make(REVIEW_FILTER, 'Zu prüfen');
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
                <span class="region-sub">${tours.length} Gruppen · ${count} Stempel · ${Math.round(km)} km${withTrack ? ` · ${withTrack} mit GPX` : ''} · ca. ${tours[0].driveKm} km Anfahrt ab ${escapeHtml(plan.home)}</span>
            </header>
            <div class="table-wrap">
                <table class="tour-table">
                    <thead><tr>
                        <th scope="col">Erledigt</th><th scope="col">Gruppe</th>
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
        : `${tour.parent ? '<span class="part-arrow" aria-hidden="true">↳</span>' : ''}${tour.id}${reviews.has(tour.id)
            ? `<span class="gpx-tag review-tag" title="${escapeHtml(reviews.get(tour.id).map(r => r.text).join('\n'))}">⚠ prüfen</span>` : ''}${tour.parts?.length ? '<span class="gpx-tag parts-tag" title="Lässt sich in zwei Teilen gehen">2 Teile</span>' : ''}${f.real ? '<span class="gpx-tag" title="Mit GPX-Track">GPX</span>' : ''}`;

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
function fillRowCells(tr, tour, owners = ownTourStampOwners(), planning = stampPlanningMap()) {
    const cells = tr.querySelectorAll('td');
    const dash = '–';
    const f = !tour.own && !isDone(tour) ? restFigures(tour, owners) : tourFigures(tour);
    const noFigures = (tour.single && !f.real) || f.empty;
    // Estimates are marked: "~" for distance/time, "≥" for ascent (only stamp-to-stamp climbs)
    const est = f.real ? '' : '<span class="est">~</span>';
    const restTitle = !f.reduced ? ''
        : f.empty ? 'Alle offenen Stempel liegen in eigenen Touren' : `Rest: ${f.rest.join(', ')} (geschätzt)`;
    const seq = tourStamps(tour)
        .map(s => {
            // Planned elsewhere (Komoot or another service) or only in an own tour with an unchecked track
            const p = planning.get(s.number);
            const elsewhere = p && p.unit !== tour && !tour.own;
            const state = collected.has(s.number) ? ' got'
                : elsewhere && p.status === 'planned' ? ' planned'
                : owners.has(s.number) && !tour.own ? ' planned unchecked' : '';
            const hint = state === ' got' ? 'gestempelt'
                : state === ' planned' ? `verplant in ${p.unit.own ? `„${p.unit.name}“` : unitLabel(p.unit)} (${ORIGIN_LABELS[p.origin]})`
                : state ? `in eigener Tour „${owners.get(s.number).name}“, Track ungeprüft` : '';
            return `<span class="seq-stop${state}"${hint ? ` title="${escapeHtml(hint)}"` : ''}><span class="mono">${s.number}</span> ${escapeHtml(s.name)}</span>`;
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
        if ((tour.parent.defaultVariant || 'whole') === 'parts') delete variants[tour.parent.id];
        else variants[tour.parent.id] = 'parts';
        saveVariants();
        updateLines();
        renderList();
        notifyChange();
    }
    selectedId = id;
    if (tour && !matchesFilter(tour)) regionFilter = null;
    render();
    if (tour) fitTo(usesParts(tour) ? tour.parts : [tour]);
    if (scrollToMap) el('tourMapGrid').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function render() {
    el('tourChips').querySelectorAll('.region-chip').forEach(b =>
        b.setAttribute('aria-pressed', String((b.dataset.code || null) === regionFilter)));
    const reviewChip = el('tourChips').querySelector(`[data-code="${REVIEW_FILTER}"] .chip-label`);
    if (reviewChip) reviewChip.textContent = `Zu prüfen (${units.filter(u => openReview(u).length).length})`;
    el('tourChips').querySelector(`[data-code="${PLANNED_FILTER}"] .chip-label`).textContent = `Geplant (${units.filter(isPlannedUnit).length})`;

    const collected = collectedStamps();
    const owners = ownTourStampOwners();
    const planning = stampPlanningMap();
    restLayer.clearLayers();
    shownUnits().forEach(tour => {
        const visible = matchesFilter(tour);
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
    const reviewStamps = new Set(units.filter(u => openReview(u).length).flatMap(u => u.stamps));
    const plannedStamps = new Set(units.filter(isPlannedUnit).flatMap(u => u.stamps));
    plan.tours.forEach(tour => tour.stamps.forEach(n => {
        const m = stampMarkers.get(n);
        if (!m) return;
        const visible = !regionFilter || tour.region === regionFilter
            || (regionFilter === OWN_REGION && ownStamps.has(n)) || (regionFilter === REVIEW_FILTER && reviewStamps.has(n))
            || (regionFilter === PLANNED_FILTER && plannedStamps.has(n));
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
    renderReviewLegs();

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

    el('tourList').querySelectorAll('.tour-row').forEach(row => {
        row.classList.toggle('selected', row.dataset.id === selectedId);
        const rowTour = unitById.get(row.dataset.id);
        // State filters show only matching rows (and the suggestion of a matching part)
        row.hidden = STATE_FILTERS.has(regionFilter) && !matchesFilter(rowTour)
            && !(rowTour.parts || []).some(matchesFilter);
        fillRowCells(row, rowTour, owners, planning);
        row.classList.toggle('done', isDone(rowTour));
        row.classList.toggle('variant-off', !isShown(rowTour));
        const cb = row.querySelector('.tour-done');
        if (cb) syncDoneCheckbox(cb, rowTour);
    });
    el('tourList').querySelectorAll('.region-card').forEach(sec => {
        sec.hidden = STATE_FILTERS.has(regionFilter)
            ? ![...sec.querySelectorAll('.tour-row')].some(r => !r.hidden)
            : !!regionFilter && sec.dataset.code !== regionFilter;
    });

    renderStats();
    renderDetail(tour);
}

function renderStats() {
    const collected = collectedStamps();
    const openStamps = stampsByNumber.size - collected.size;
    const planned = plannedCount();
    // Every open stamp counts once: planned own tours with their track, plus what is left of each
    // open suggestion (split tours with the chosen variant, never both)
    const owners = ownTourStampOwners();
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
        <div class="route-stat"><div class="label">Stempel gesammelt</div><div class="value highlight">${collected.size}</div>${nextLevelHtml()}<a class="stat-link" href="#stempel">Alle Stempel ansehen</a></div>
        <div class="route-stat"><div class="label">Offene Stempel</div><div class="value">${openStamps}</div></div>`
        + (planned ? `<div class="route-stat" title="Offene Stempel mit Komoot-Track oder Track aus einem anderen Dienst"><div class="label">davon verplant</div><div class="value">${planned}</div></div>` : '')
        + `
        <div class="route-stat"><div class="label">Gruppen</div><div class="value">${plan.tours.filter(t => !t.single).length}</div></div>
        <div class="route-stat" title="Geplante eigene Touren plus der Rest der offenen Gruppen${openKmEstimated ? '; teilweise geschätzt (ohne GPX-Track oder Rest-Runde)' : ''}"><div class="label">km offen</div><div class="value">${openKmEstimated ? '~' : ''}${Math.round(openKm)}</div></div>
        <div class="route-stat"${openHmEstimated ? ' title="Teilweise geschätzt (nur Anstiege von Stempel zu Stempel), echte Höhenmeter liegen meist höher"' : ''}><div class="label">Hm offen</div><div class="value">${openHmEstimated ? '≥' : ''}${hm(openHm)}</div></div>
        <div class="route-stat"${walkedEstimated ? ' title="Teilweise geschätzt: nicht jede erledigte Tour hat einen GPX-Track"' : ''}><div class="label">km zurückgelegt</div><div class="value highlight">${walkedEstimated ? '~' : ''}${fmt1(walkedKm)}</div></div>
        <div class="route-stat"${walkedHmEstimated ? ' title="Teilweise geschätzt: nicht jede erledigte Tour hat einen GPX-Track mit Höhendaten"' : ''}><div class="label">Hm zurückgelegt</div><div class="value highlight">${walkedHmEstimated ? '≥' : ''}${hm(walkedHm)}</div></div>
        <div class="route-stat"><div class="label">Gruppen erledigt</div><div class="value highlight">${plan.tours.filter(isDone).length}</div></div>`
        + (ownTours.length ? `<div class="route-stat"><div class="label">Eigene Touren gelaufen</div><div class="value highlight">${walkedOwn.length}/${ownTours.length}</div></div>` : '');
}

// Next badge level under "Stempel gesammelt", e.g. "noch 7 bis Wanderkönig/-in"
function nextLevelHtml() {
    const next = badges && badgeProgress(badges, collected, stampDate, [...stampsByNumber.keys()]).next;
    if (!next) return '';
    const name = next.name.replace(/^Harzer (Wandernadel )?/, '');
    const what = next.remaining ? `noch ${next.remaining}` : `${next.missingRequired.length} Pflichtstempel`;
    return `<div class="stat-next" title="${escapeHtml(next.name)}">${what} bis ${escapeHtml(name)}</div>`;
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
        parts.push(`<p class="hint">Noch keine Route, nur die Luftlinie als Skizze. ${tour.single ? '' : '„In Komoot planen“ öffnet den Komoot-Planer mit den Stempeln als Wegpunkten. '}Speichere die Tour in Komoot, exportiere das GPX und hinterlege es hier: Dann zeigt die Karte den echten Weg, km und Hm kommen aus dem Track, und die Stempel zählen als verplant. Der Erledigt-Status ändert sich dadurch nicht.</p>`);
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
    if (!tour && regionFilter === REVIEW_FILTER) {
        detail.style.setProperty('--c', REVIEW_COLOR);
        const open = units.filter(u => openReview(u).length);
        detail.innerHTML = `
            <h3><span aria-hidden="true">⚠</span> Zu prüfen</h3>
            <p class="hint">${open.length} ${open.length === 1 ? 'Gruppe oder Teil hat' : 'Gruppen und Teile haben'} Hinweise. Umweg-Etappen sind auf der Karte orange hinterlegt.</p>
            <ul class="review-list">${open.map(u => `<li>
                <button type="button" class="part-link" data-unit="${u.id}">${escapeHtml(unitLabel(u))}</button>
                <span class="hint">${openReview(u).map(r => ({ note: 'Umbau', detour: 'Umweg', backtrack: 'Hin und zurück', longer: 'länger als geschätzt', parts: 'Teile kürzer' })[r.kind]).join(' · ')}</span>
            </li>`).join('')}</ul>`;
        detail.querySelectorAll('[data-unit]').forEach(btn => btn.addEventListener('click', () => select(btn.dataset.unit)));
        return;
    }
    if (!tour && regionFilter === PLANNED_FILTER) {
        detail.style.setProperty('--c', PLANNED_COLOR);
        const planned = units.filter(isPlannedUnit);
        const stampCount = new Set(planned.flatMap(u => u.stamps.filter(n => !collected.has(n)))).size;
        const km = planned.reduce((a, u) => a + tourFigures(u).km, 0);
        detail.innerHTML = `
            <h3>Geplant</h3>
            <p class="hint">${planned.length
                ? `${planned.length} ${planned.length === 1 ? 'Tour' : 'Touren'} mit ${stampCount} offenen Stempeln, zusammen etwa ${Math.round(km)} km.`
                : 'Noch nichts geplant.'} Geplant sind eigene Touren, die noch nicht gelaufen sind, und offene Gruppen mit Komoot-Track (oder Track aus einem anderen Dienst).</p>
            ${planned.length ? `<ul class="review-list">${planned.map(u => `<li>
                <button type="button" class="part-link" data-unit="${u.id}">${escapeHtml(unitLabel(u))}</button>
                <span class="hint">${fmt1(tourFigures(u).km)} km · ${u.stamps.filter(n => !collected.has(n)).length} offene Stempel</span>
            </li>`).join('')}</ul>` : ''}`;
        detail.querySelectorAll('[data-unit]').forEach(btn => btn.addEventListener('click', () => select(btn.dataset.unit)));
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
        <h3>${tour.parent ? 'Teil' : 'Gruppe'} <span class="mono">${tour.id}</span>${tour.parent ? ` <span class="part-title">${escapeHtml(tour.name)}</span>` : ''}${isDone(tour)
            ? ' <span class="level lv-leicht">✓ erledigt</span>'
            : isPartial(tour) ? ` <span class="level lv-mittel">${collectedCount(tour)}/${stamps.length} gestempelt</span>` : ''}</h3>
        <div class="tour-meta mono">${meta}<span>${f.minEle}–${f.maxEle} m ü. NN</span><span>${stamps.length} Stempel</span></div>
        ${tour.parent ? partInfoHtml(tour) : `<p class="hint suggestion-hint">${tour.single
            ? 'Einzelstempel: liegt zu abseits für eine Runde.'
            : 'Stempel, die gut an einem Tag zusammenpassen. Die Linie auf der Karte ist nur eine Skizze (Luftlinie), keine Route: Plane den Weg in Komoot und hinterlege das GPX.'}</p>`}
        ${reviewHtml(tour)}
        ${tour.parts?.length ? variantHtml(tour) : ''}
        ${restHtml(tour)}
        ${tipsHtml(tour)}
        ${stopListHtml(stamps)}
        <p class="hint">${tour.single
            ? 'Liegt zu abseits für eine Runde; nimm ihn auf dem Weg zu einer Nachbartour mit.'
            : 'Die Reihenfolge ist ein Vorschlag für eine Runde, du kannst an jedem Stempel starten.'}</p>
        <div class="done-box">
            <label><input type="checkbox" id="tourDoneToggle"> Alle Stempel gesammelt</label>
            <span class="hint">Setzt oder entfernt die Haken aller Stempel ${tour.parent ? 'dieses Teils' : 'dieser Gruppe'}. Einzelne Stempel hakst du in der Liste oben ab. Ein GPX-Track allein ändert am Fortschritt nichts.</span>
        </div>
        <div class="track-box">
            ${trackInfoHtml(tour)}
            <div class="detail-actions">
                <button type="button" class="calc-route-btn" id="trackUpload">${track ? 'GPX ersetzen' : 'GPX hinterlegen'}</button>
                ${tour.single ? '' : `<a class="calc-route-btn komoot-plan" id="komootPlan" href="${escapeHtml(komootPlanUrl(stamps))}" target="_blank" rel="noopener" title="Öffnet den Komoot-Planer mit den Stempeln als Wegpunkten (Runde)">${track ? 'Neu in Komoot planen' : 'In Komoot planen'} →</a>`}
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
        // Same name as the project file (src/data/tours/<ID>.gpx), so a download can be dropped in as is
        fileName: tour.id,
        compareName: track ? `${unitLabel(tour)}: ${track.name}` : `${unitLabel(tour)} (Luftlinie)`
    });

    const fileInput = el('trackFile');
    el('trackUpload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) uploadTrack(tour, file);
    });
    el('trackRemove')?.addEventListener('click', () => removeUploadedTrack(tour));
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
    const owners = ownTourStampOwners();
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
        ...[...byOwner].map(([owner, numbers]) => {
            const link = `<button type="button" class="part-link" data-own="${owner.id}">„${escapeHtml(owner.name)}“</button>`;
            return hasCheckedTrack(owner)
                ? `<li><b>Verplant</b> in ${link}: ${names(numbers)}</li>`
                : `<li><b>In eigener Tour</b> ${link} (Track ungeprüft): ${names(numbers)}</li>`;
        }),
        f.empty
            ? '<li><b>Rest:</b> keiner, alle offenen Stempel liegen in eigenen Touren.</li>'
            : `<li><b>Rest:</b> ${names(f.rest)}${f.rest.length > 1
                ? ` <span class="mono">· ~${fmt1(f.km)} km · ≥${f.ascent} Hm</span> ${levelHtml(tour, f)}`
                : ''}</li>`
    ].filter(Boolean).join('');

    const hint = f.empty ? ''
        : f.rest.length === 1
            ? 'Nur noch ein Stempel offen: am besten als Abstecher auf einer anderen Tour mitnehmen.'
            : 'Die Rest-Werte sind geschätzt (Luftlinie × 1,4, Hm nur von Stempel zu Stempel). Auf der Karte ist die Rest-Runde gepunktet. „Rest in Komoot planen“ öffnet Komoot mit den restlichen Stempeln; das GPX legst du dann mit „+ Eigene Tour aus GPX“ an.';
    return `<div class="rest-box">
        <b>Stand ${tour.parent ? 'dieses Teils' : 'dieser Gruppe'}</b>
        <ul>${items}</ul>
        ${hint ? `<p class="hint">${hint}</p>` : ''}
        ${f.rest.length > 1 ? `<div class="detail-actions"><a class="calc-route-btn komoot-plan" id="restKomoot" href="${escapeHtml(komootPlanUrl(f.rest.map(n => stampsByNumber.get(n))))}" target="_blank" rel="noopener">Rest in Komoot planen →</a></div>` : ''}
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
                <span class="stop-id">${s.id}${s.elevation ? ` · ${s.elevation} m` : ''}${suggestion ? ` · Gruppe ${suggestion.id}` : ''}</span>
                <label class="stamp-check" title="Gestempelt"><input type="checkbox" class="stamp-done" data-stamp="${s.number}"${collected.has(s.number) ? ' checked' : ''} aria-label="${escapeHtml(`${s.id} ${s.name} gestempelt`)}"></label>
            </li>`;
    }).join('')}
        </ol>`;
}

function komootBoxHtml(tour) {
    // A link alone doesn't say which stamps the Komoot tour covers, so it doesn't make them "verplant"
    const linkOnly = tourKomootLinks(tour).length && !hasCheckedTrack(tour) && !isDone(tour);
    return `<div class="komoot-box">
            <b>Komoot</b>
            ${komootHtml(tour)}
            ${linkOnly ? '<p class="hint">Komoot verlinkt: GPX aus Komoot hinterlegen, damit die Stempel als verplant zählen.</p>' : ''}
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
        fitTo(shownUnits().filter(matchesFilter));
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
            <p class="hint track-source"><b>${!track ? 'Eigene Tour' : track.origin === 'ors' ? 'Eigene Tour, Weg von OpenRouteService (ungeprüft)' : `Eigene Tour, ${ORIGIN_LABELS[track.origin]}`}:</b> <span class="mono">${escapeHtml(tour.record.fileName || 'GPX')}</span> · im Browser gespeichert, wird mit exportiert</p>
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
            <span class="hint">${Math.round(a.distance)} m vom Track${suggestion ? ` · Gruppe ${suggestion.id}` : ''}${collected.has(a.number) ? ' · schon gestempelt' : ''}</span>
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
    if (record.status === 'walked') record.walkedAt = existing?.walkedAt || today();
    try {
        await saveOwnTour(record);
    } catch {
        d.message = { text: 'Speichern fehlgeschlagen.', isError: true };
        render();
        return;
    }
    // A walked tour collects its (possibly new) stamps
    if (record.status === 'walked') {
        collectStamps(record.stamps, true, record.walkedAt);
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
    return `<p class="hint suggestion-hint">Teil von Gruppe ${part.parent.id}: eine eigene Runde. Zusammen mit
        Teil ${sibling.id} (${escapeHtml(sibling.name)}) deckt er alle Stempel der Gruppe ab.</p>
        <button type="button" class="detail-clear" id="tourParent">← Zu Gruppe ${part.parent.id}</button>`;
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
            <label><input type="radio" name="tourVariant" value="parts"${parts ? ' checked' : ''}> In zwei Teilen${tour.defaultVariant === 'parts' ? ' (empfohlen)' : ''}</label>
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

// Store a new own tour (from the rest of a suggestion or a copy of it) and open it
async function createOwnTour(record, message) {
    await saveOwnTour(record);
    detailMessage = { tourId: record.id, text: message, isError: false };
    setOwnTours([...ownTours, record]);
    select(record.id);
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
    markBackup();
    downloadJSON({
        format: PROGRESS_FORMAT,
        version: 4,
        exportedAt: new Date().toISOString(),
        // v3: stamps are authoritative; doneTours is derived and kept for older app versions
        stamps: [...collected].sort((a, b) => a - b),
        // v4: date per collected stamp (stamps without a date are missing here)
        stampDates: datesObject(),
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
    // v1-v3 have no dates: every imported stamp is "ohne Datum"
    stampDates = sanitizeDates(data.stampDates);
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
    markBackup();
    document.dispatchEvent(new CustomEvent('hwn:progress-changed'));

    const doneCount = plan.tours.filter(isDone).length;
    let msg = `Importiert: ${doneCount} ${doneCount === 1 ? 'Gruppe' : 'Gruppen'} erledigt, ${collected.size} Stempel gesammelt`;
    if (trackCount !== null) msg += `, ${trackCount} GPX-Track${trackCount === 1 ? '' : 's'}`;
    if (ownCount !== null) msg += `, ${ownCount} eigene ${ownCount === 1 ? 'Tour' : 'Touren'}`;
    msg += '.';
    setTransferStatus(unknownTours.length ? `${msg} Unbekannte Touren ignoriert: ${unknownTours.join(', ')}` : msg);
}

// Uploaded tracks override the project files; during development they hide changes to those files
function updateUploadsButton() {
    const count = Object.keys(uploadedTracks).length;
    el('uploadsClear').hidden = !count;
    el('uploadsClear').textContent = `Browser-Tracks löschen (${count})`;
    if (!count) el('uploadsConfirm').hidden = true;
}

function initUploadsClear() {
    el('uploadsClear').addEventListener('click', () => {
        const count = Object.keys(uploadedTracks).length;
        el('uploadsConfirmText').textContent = `${count} im Browser hinterlegte${count === 1 ? 'n Track' : ' Tracks'} löschen? `
            + 'Projektdateien, eigene Touren, Komoot-Links und Fortschritt bleiben.';
        el('uploadsConfirm').hidden = false;
    });
    el('uploadsClearNo').addEventListener('click', () => {
        el('uploadsConfirm').hidden = true;
    });
    el('uploadsClearYes').addEventListener('click', async () => {
        const count = Object.keys(uploadedTracks).length;
        try {
            await clearUploadedTracks();
        } catch {
            setTransferStatus('Browser-Tracks konnten nicht gelöscht werden.', true);
            return;
        }
        uploadedTracks = {};
        el('uploadsConfirm').hidden = true;
        setTransferStatus(`${count} Browser-Track${count === 1 ? '' : 's'} gelöscht. Es gelten wieder die Projektdateien.`);
        refreshTracks();
    });
}

// A file export or import is a backup: the reminder starts over
function markBackup() {
    writeStorage(BACKUP_STORAGE, JSON.stringify({ at: new Date().toISOString(), stamps: collected.size }));
    writeStorage(CHANGES_STORAGE, '0');
    writeStorage(SNOOZE_STORAGE, null);
    renderBackupHint();
}

const localDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

function daysAgoText(days) {
    return days <= 0 ? 'heute' : days === 1 ? 'gestern' : `vor ${days} Tagen`;
}

/**
 * Reminder above the backup bar: urgent when nothing was ever saved or the last backup is old
 * or far behind, a short note otherwise. "Später erinnern" quiets the urgent state for a week.
 */
function renderBackupHint() {
    const hint = el('backupHint');
    if (!hint || !plan) return;
    const backup = lastBackup();
    const changes = changesSinceBackup();
    const snoozed = Date.parse(readStorage(SNOOZE_STORAGE)) > Date.now();
    const protectedNote = storagePersisted ? ' Der Browser hält den Speicher dauerhaft.' : '';
    let text = '';
    let urgent = false;
    if (!backup) {
        urgent = collected.size > 0;
        text = urgent ? `Dein Stand (${collected.size} Stempel) ist nur in diesem Browser gespeichert.` : '';
    } else {
        const at = new Date(backup.at);
        const days = Math.round((localDay(new Date()) - localDay(at)) / 86400000);
        if (changes) {
            urgent = days >= BACKUP_DUE_DAYS || changes >= BACKUP_DUE_CHANGES;
            text = `Letzte Sicherung ${daysAgoText(days)}, seitdem ${changes} ${changes === 1 ? 'Änderung' : 'Änderungen'}.`;
        } else {
            text = `Gesichert am ${at.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}.`;
        }
    }
    if (urgent && snoozed) {
        urgent = false;
        if (!backup) text = '';
    }
    hint.hidden = !text;
    hint.classList.toggle('urgent', urgent);
    el('backupHintText').textContent = text + protectedNote;
    el('backupNow').hidden = !urgent;
    el('backupSnooze').hidden = !urgent;
}

// The bar lives outside the views and is shown on "Meine Stempel" and in the Tourenplan
let backupBarReady = false;
function initBackupBar() {
    if (backupBarReady || !el('backupBar')) return;
    backupBarReady = true;
    initProgressTransfer();
    initUploadsClear();
    updateUploadsButton();
    el('backupNow').addEventListener('click', exportProgress);
    el('backupSnooze').addEventListener('click', () => {
        writeStorage(SNOOZE_STORAGE, new Date(Date.now() + BACKUP_SNOOZE_DAYS * 86400000).toISOString());
        renderBackupHint();
    });
    globalThis.navigator?.storage?.persisted?.().then(p => {
        storagePersisted = p;
        renderBackupHint();
    }).catch(() => {});
    renderBackupHint();
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
