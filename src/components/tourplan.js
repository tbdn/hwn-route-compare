// Tourenplan: precomputed round tours covering all stamps, grouped by region.
// Has its own Leaflet map so it doesn't interfere with the route comparison map.
// Tours can carry a real GPX track (project file or browser upload) that replaces the straight-line loop.

import { generateGPX, downloadGPX } from "../utils/optimize.js";
import {
    analyzeTrack, loadProjectTracks, loadUploadedTracks, saveUploadedTrack,
    deleteUploadedTrack, clearUploadedTracks, STAMP_ON_TRACK_METERS
} from "../utils/tracks.js";
import { distanceMeters } from "../utils/geo.js";

const HARZ_CENTER = [51.72, 10.75];
const DONE_STORAGE = 'hwn-tours-done';
const EXTRA_STAMPS_STORAGE = 'hwn-stamps-extra';
const KOMOOT_STORAGE = 'hwn-komoot-links';
const PROGRESS_FORMAT = 'hwn-tourenplan-progress';
// Start and end closer than this are shown as one "Start/Ziel" marker
const LOOP_CLOSE_METERS = 250;

// Region colors, readable on paper and on OSM tiles
const REGION_COLORS = {
    A: '#1F7A6A', B: '#3457A8', C: '#7550A8', D: '#B04A22',
    E: '#7C6C10', F: '#AD2F63', G: '#3F7F2E', H: '#5A6070'
};
const STAMPED_COLOR = '#9A958A';

const el = id => document.getElementById(id);

let initialized = false;
let map = null;
let plan = null;
let stampsByNumber = new Map();
let doneTours = new Set();
let extraStamps = new Set();      // collected outside of any finished tour (from imports)
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

function saveDone() {
    saveSet(DONE_STORAGE, doneTours);
}

// Progress lives only in browser storage: imported extras + every stamp of a finished tour
function collectedStamps() {
    const collected = new Set(extraStamps);
    plan.tours.filter(isDone).forEach(t => t.stamps.forEach(n => collected.add(n)));
    return collected;
}

function isDone(tour) {
    return doneTours.has(tour.id);
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
        return { real: false, km: tour.km, hours: tour.hours, ascent: tour.ascent, minEle: tour.minEle, maxEle: tour.maxEle };
    }
    return {
        real: true,
        km: track.km,
        hours: track.km / 4 + tour.stamps.length * 0.1,
        ascent: track.ascent,
        minEle: track.minEle ?? tour.minEle,
        maxEle: track.maxEle ?? tour.maxEle
    };
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
 * Start and end points of a tour, one pair per track segment.
 * A loop (start ≈ end) collapses into a single "Start/Ziel" point.
 * @returns {Array<{latLng: number[], kind: 'start'|'end'|'both', title: string}>}
 */
function tourEndpoints(tour) {
    const raw = loopLatLngs(tour);
    if (!raw.length) return [];
    const segments = Array.isArray(raw[0][0]) ? raw : [raw];
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
    const selected = plan.tours.find(t => t.id === selectedId);
    // With a selection only that tour gets (large) markers; otherwise every visible tour gets small ones
    const tours = selected ? [selected] : plan.tours.filter(t => !regionFilter || t.region === regionFilter);

    tours.forEach(tour => {
        const big = tour === selected;
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
                .bindTooltip(`Tour ${tour.id} · ${p.title}`)
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
    doneTours = loadSet(DONE_STORAGE);
    extraStamps = loadSet(EXTRA_STAMPS_STORAGE);
    komootLinks = sanitizeKomootLinks(loadKomootLinks(), new Set(plan.tours.map(t => t.id)));

    initTourMap();
    initProgressTransfer();
    renderChips();
    renderList();
    render();

    // Tracks load in the background; the straight-line plan is usable meanwhile
    [projectTracks, uploadedTracks] = await Promise.all([
        loadProjectTracks(plan.tours.map(t => t.id)),
        loadUploadedTracks()
    ]);
    refreshTracks();
}

// Rebuild the effective track per tour (upload beats project file) and redraw
function refreshTracks() {
    tracks.clear();
    trackErrors.clear();
    plan.tours.forEach(tour => {
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

    plan.tours.forEach(tour => {
        const latLngs = loopLatLngs(tour);
        loopLines.get(tour.id).setLatLngs(latLngs);
        hitLines.get(tour.id).setLatLngs(latLngs);
    });
    renderList();
    render();
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

    plan.tours.forEach(tour => {
        const latLngs = loopLatLngs(tour);

        const line = L.polyline(latLngs, {
            color: color(tour.region),
            weight: 3,
            opacity: 0.85,
            lineJoin: 'round',
            interactive: false
        }).addTo(loopLayer);

        // Wide transparent line makes the loop easy to hit
        const hit = L.polyline(latLngs, { weight: 16, opacity: 0 })
            .bindTooltip(() => {
                const f = tourFigures(tour);
                return `Tour ${tour.id} · ${tour.stamps.length} Stempel · ${f.real ? '' : 'ca. '}${fmt1(f.km)} km`
                    + (f.real ? ' · GPX' : '') + (isDone(tour) ? ' · erledigt' : '');
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
            + (collectedStamps().has(number) ? ' · gestempelt' : tour ? ` · Tour ${tour.id}` : '')
        );
        if (tour) marker.on('click', () => select(tour.id));
        marker.addTo(pointLayer);
        stampMarkers.set(number, marker);
    });

    fitTo(plan.tours);
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
            fitTo(code ? plan.tours.filter(t => t.region === code) : plan.tours);
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
        const km = tours.reduce((a, t) => a + tourFigures(t).km, 0);
        const count = tours.reduce((a, t) => a + t.stamps.length, 0);
        const withTrack = tours.filter(t => tracks.has(t.id)).length;

        const sec = document.createElement('section');
        sec.className = 'card region-card';
        sec.dataset.code = region.code;
        sec.style.setProperty('--c', color(region.code));
        sec.innerHTML = `
            <header class="region-head">
                <h3><span class="mono region-code">${region.code}</span> ${escapeHtml(region.name)}</h3>
                <span class="region-sub">${tours.length} Touren · ${count} Stempel · ${Math.round(km)} km${withTrack ? ` · ${withTrack} mit GPX` : ''} · ca. ${tours[0].driveKm} km Anfahrt ab ${escapeHtml(plan.home)}</span>
            </header>
            <div class="table-wrap">
                <table class="tour-table">
                    <thead><tr>
                        <th scope="col">Erledigt</th><th scope="col">Tour</th>
                        <th scope="col" class="r">km</th><th scope="col" class="r">Std.</th><th scope="col" class="r">Hm</th>
                        <th scope="col">Niveau, Zeit</th><th scope="col">Stempel in Reihenfolge</th>
                    </tr></thead>
                    <tbody></tbody>
                </table>
            </div>`;

        const tbody = sec.querySelector('tbody');
        tours.forEach(tour => tbody.appendChild(createTourRow(tour)));
        list.appendChild(sec);
    });
}

function createTourRow(tour) {
    const tr = document.createElement('tr');
    tr.className = 'tour-row';
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
        <td><input type="checkbox" class="tour-done" aria-label="Tour ${tour.id} erledigt"></td>
        <td class="tour-id mono">${tour.id}${f.real ? '<span class="gpx-tag" title="Mit GPX-Track">GPX</span>' : ''}${tourKomootLinks(tour).length ? '<span class="gpx-tag komoot-tag" title="Mit Komoot-Link">komoot</span>' : ''}</td>
        <td class="r mono">${noFigures ? dash : est + fmt1(f.km)}</td>
        <td class="r mono">${noFigures ? dash : est + fmt1(f.hours)}</td>
        <td class="r mono">${noFigures ? dash : (f.real ? '' : '<span class="est">≥</span>') + f.ascent}</td>
        <td>${tour.single ? '' : `<span class="level lv-${tour.level}">${tour.level}</span><br>`}${tour.tags
            .map(g => `<span class="season" title="${escapeHtml(g.hint)}">${escapeHtml(g.label)}</span>`).join('')}</td>
        <td class="seq">${tour.single ? '<span class="detour-tag">Abstecher</span> ' : ''}${seq}</td>`;

    const cb = tr.querySelector('.tour-done');
    cb.checked = isDone(tour);
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => {
        cb.checked ? doneTours.add(tour.id) : doneTours.delete(tour.id);
        saveDone();
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

function select(id, scrollToMap = false) {
    selectedId = id;
    const tour = plan.tours.find(t => t.id === id);
    if (tour && regionFilter && tour.region !== regionFilter) regionFilter = null;
    render();
    if (tour) fitTo([tour]);
    if (scrollToMap) el('tourMapGrid').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function render() {
    el('tourChips').querySelectorAll('.region-chip').forEach(b =>
        b.setAttribute('aria-pressed', String((b.dataset.code || null) === regionFilter)));

    const collected = collectedStamps();
    plan.tours.forEach(tour => {
        const visible = !regionFilter || tour.region === regionFilter;
        const done = isDone(tour);
        const real = tracks.has(tour.id);
        const line = loopLines.get(tour.id);
        const isSel = selectedId === tour.id;
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
    const tour = plan.tours.find(t => t.id === selectedId);
    if (tour) {
        tourStamps(tour).forEach((s, i) => {
            L.marker([s.lat, s.lon], {
                icon: L.divIcon({
                    className: 'stop-marker',
                    html: `<div class="stop-marker-inner" style="background:${color(tour.region)}">${i + 1}</div>`,
                    iconSize: [28, 28],
                    iconAnchor: [14, 14]
                }),
                title: `${i + 1}. ${s.name}`,
                zIndexOffset: 2000
            }).addTo(labelLayer);
        });
    }

    el('tourList').querySelectorAll('.region-card').forEach(sec => {
        sec.hidden = !!regionFilter && sec.dataset.code !== regionFilter;
    });
    el('tourList').querySelectorAll('.tour-row').forEach(row => {
        row.classList.toggle('selected', row.dataset.id === selectedId);
        const done = isDone(plan.tours.find(t => t.id === row.dataset.id));
        row.classList.toggle('done', done);
        row.querySelector('.tour-done').checked = done;
    });

    renderStats();
    renderDetail(tour);
}

function renderStats() {
    const collected = collectedStamps();
    const openStamps = stampsByNumber.size - collected.size;
    const openList = plan.tours.filter(t => !isDone(t));
    const openKm = openList.reduce((a, t) => a + tourFigures(t).km, 0);
    // Estimated ascent only counts climbs between stamps, so it's a lower bound ("≥")
    const openHm = openList.reduce((a, t) => a + tourFigures(t).ascent, 0);
    const openHmEstimated = openList.some(t => !tracks.has(t.id));

    // Walked distance: real track where there is one, otherwise the plan's estimate
    const doneList = plan.tours.filter(isDone);
    const walkedKm = doneList.reduce((a, t) => a + tourFigures(t).km, 0);
    const walkedHm = doneList.reduce((a, t) => a + tourFigures(t).ascent, 0);
    const walkedEstimated = doneList.some(t => !tracks.has(t.id));
    const hm = n => Math.round(n).toLocaleString('de-DE');

    el('tourStats').innerHTML = `
        <div class="route-stat"><div class="label">Stempel gesammelt</div><div class="value highlight">${collected.size}</div></div>
        <div class="route-stat"><div class="label">Offene Stempel</div><div class="value">${openStamps}</div></div>
        <div class="route-stat"><div class="label">Rundtouren</div><div class="value">${plan.tours.filter(t => !t.single).length}</div></div>
        <div class="route-stat"><div class="label">km offen</div><div class="value">${Math.round(openKm)}</div></div>
        <div class="route-stat"${openHmEstimated ? ' title="Teilweise geschätzt (nur Anstiege von Stempel zu Stempel), echte Höhenmeter liegen meist höher"' : ''}><div class="label">Hm offen</div><div class="value">${openHmEstimated ? '≥' : ''}${hm(openHm)}</div></div>
        <div class="route-stat"${walkedEstimated ? ' title="Teilweise geschätzt: nicht jede erledigte Tour hat einen GPX-Track"' : ''}><div class="label">km zurückgelegt</div><div class="value highlight">${walkedEstimated ? '~' : ''}${fmt1(walkedKm)}</div></div>
        <div class="route-stat"${walkedEstimated ? ' title="Teilweise geschätzt: nicht jede erledigte Tour hat einen GPX-Track"' : ''}><div class="label">Hm zurückgelegt</div><div class="value highlight">${walkedEstimated ? '≥' : ''}${hm(walkedHm)}</div></div>
        <div class="route-stat"><div class="label">Touren erledigt</div><div class="value highlight">${plan.tours.filter(isDone).length}</div></div>`;
}

function trackInfoHtml(tour) {
    const track = tracks.get(tour.id);
    const error = trackErrors.get(tour.id);
    const parts = [];

    if (track) {
        const source = track.source === 'upload' ? 'im Browser hinterlegt' : 'Projektdatei';
        parts.push(`<p class="hint track-source"><b>GPX-Track:</b> <span class="mono">${escapeHtml(track.name)}</span> · ${source}`
            + (track.source === 'upload' && projectTracks[tour.id] ? ' (ersetzt die Projektdatei)' : '') + '</p>');
        if (track.missed.length) {
            const list = track.missed
                .map(m => `${m.number} ${escapeHtml(stampsByNumber.get(m.number)?.name || '')} (${Math.round(m.distance)} m)`)
                .join(', ');
            parts.push(`<p class="hint track-warning">⚠ Nicht am Track (mehr als ${STAMP_ON_TRACK_METERS} m entfernt): ${list}</p>`);
        }
    } else {
        parts.push(`<p class="hint">Noch kein GPX-Track. Lade die Tour aus Komoot hoch, dann zeigt die Karte den echten Weg statt der Luftlinie.</p>`);
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
        const km = Math.round(tours.reduce((a, t) => a + tourFigures(t).km, 0));
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
    detail.style.setProperty('--c', color(tour.region));

    const ca = f.real ? '' : 'ca. ';
    const meta = tour.single && !f.real
        ? '<span>Abstecher mit dem Auto</span>'
        : `<span>${ca}${fmt1(f.km)} km</span><span>ca. ${fmt1(f.hours)} Std.</span><span>${f.real ? '' : 'mind. '}${f.ascent} Hm</span>`
            + (tour.single ? '' : `<span class="level lv-${tour.level}">${tour.level}</span>`);

    // Round trip: start and end at the first stamp, the others as waypoints
    const ll = s => `${s.lat},${s.lon}`;
    const mapsUrl = tour.single
        ? `https://www.google.com/maps?q=${ll(stamps[0])}`
        : `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${ll(stamps[0])}`
            + `&destination=${ll(stamps[0])}&waypoints=${encodeURIComponent(stamps.slice(1).map(ll).join('|'))}`;

    detail.innerHTML = `
        <span class="region-tag">${escapeHtml(regionName(tour.region))}</span>
        <h3>Tour <span class="mono">${tour.id}</span>${isDone(tour) ? ' <span class="level lv-leicht">✓ erledigt</span>' : ''}</h3>
        <div class="tour-meta mono">${meta}<span>${f.minEle}–${f.maxEle} m ü. NN</span><span>${stamps.length} Stempel</span></div>
        <ul class="tips">${tour.tags.map(g => `<li><b>${escapeHtml(g.label)}:</b> ${escapeHtml(g.hint)}</li>`).join('')}</ul>
        <ol class="stop-list">${stamps.map((s, i) => `
            <li class="stop-item">
                <span class="stop-number">${i + 1}</span>
                <span class="stop-name">${escapeHtml(s.name)}</span>
                <span class="stop-id">${s.id}${s.elevation ? ` · ${s.elevation} m` : ''}</span>
            </li>`).join('')}
        </ol>
        <p class="hint">${tour.single
            ? 'Liegt zu abseits für eine Runde; nimm ihn auf dem Weg zu einer Nachbartour mit.'
            : 'Die Runde ist geschlossen, du kannst an jedem Stempel starten.'}</p>
        <div class="track-box">
            ${trackInfoHtml(tour)}
            <div class="detail-actions">
                <button type="button" class="calc-route-btn" id="trackUpload">${track ? 'GPX ersetzen' : 'GPX hinterlegen'}</button>
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
            <a class="detail-link" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">Google Maps →</a>
            <button type="button" class="detail-clear" id="tourClear">Auswahl aufheben</button>
        </div>`;

    el('tourGpx').addEventListener('click', () => {
        if (track) {
            downloadGPX(track.gpx, `HWN_${tour.id}`);
            return;
        }
        const gpx = generateGPX(stamps, {
            name: `HWN Tour ${tour.id}`,
            description: `${regionName(tour.region)} · ${stamps.length} Stempel · ca. ${fmt1(tour.km)} km`,
            closeLoop: !tour.single
        });
        downloadGPX(gpx, `HWN_${tour.id}`);
    });
    el('tourClear').addEventListener('click', () => {
        selectedId = null;
        render();
        fitTo(regionFilter ? plan.tours.filter(t => t.region === regionFilter) : plan.tours);
    });

    const fileInput = el('trackFile');
    el('trackUpload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) uploadTrack(tour, file);
    });
    el('trackRemove')?.addEventListener('click', () => removeUploadedTrack(tour));

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
        version: 2,
        exportedAt: new Date().toISOString(),
        doneTours: plan.tours.filter(isDone).map(t => t.id),
        stamps: [...collectedStamps()].sort((a, b) => a - b),
        tracks: exportedTracks,
        komoot: komootLinks
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
    if (data?.format !== PROGRESS_FORMAT || !Array.isArray(data.doneTours) || !Array.isArray(data.stamps)) {
        throw new Error('Datei ist kein HWN-Fortschritt-Export.');
    }

    const tourIds = new Set(plan.tours.map(t => t.id));
    const unknownTours = data.doneTours.filter(id => !tourIds.has(id));

    // The file replaces the browser state
    doneTours = new Set(data.doneTours.filter(id => tourIds.has(id)));
    extraStamps = new Set();
    const covered = collectedStamps();
    extraStamps = new Set(data.stamps.map(Number).filter(n => stampsByNumber.has(n) && !covered.has(n)));
    saveDone();
    saveSet(EXTRA_STAMPS_STORAGE, extraStamps);

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
    refreshTracks();

    let msg = `Importiert: ${plan.tours.filter(isDone).length} Touren erledigt, ${collectedStamps().size} Stempel gesammelt`;
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
