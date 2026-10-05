// Tourenplan: precomputed round tours covering all open stamps, grouped by region.
// Has its own Leaflet map so it doesn't interfere with the route comparison map.

import { generateGPX, downloadGPX } from "../utils/optimize.js";

const HARZ_CENTER = [51.72, 10.75];
const DONE_STORAGE = 'hwn-tours-done';

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
let stamped = new Set();
let doneTours = new Set();
let regionFilter = null;
let selectedId = null;

const loopLines = new Map();      // tourId -> visible polyline
const stampMarkers = new Map();   // stamp number -> circleMarker
let labelLayer = null;

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

const fmt1 = n => n.toFixed(1).replace('.', ',');
const color = code => REGION_COLORS[code] || '#3D3563';

function loadDone() {
    try {
        doneTours = new Set(JSON.parse(localStorage.getItem(DONE_STORAGE) || '[]'));
    } catch {
        doneTours = new Set();
    }
}

function saveDone() {
    try {
        localStorage.setItem(DONE_STORAGE, JSON.stringify([...doneTours]));
    } catch {
        // ignore
    }
}

// Tours marked done in the data are fixed; others can be ticked off in the browser
function isDone(tour) {
    return !!tour.done || doneTours.has(tour.id);
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
    stamped = new Set(plan.stamped);
    loadDone();

    initTourMap();
    renderChips();
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
    labelLayer = L.layerGroup().addTo(map);

    plan.tours.forEach(tour => {
        if (tour.single) return;
        const latLngs = tourStamps(tour).map(s => [s.lat, s.lon]);
        latLngs.push(latLngs[0]);

        const line = L.polyline(latLngs, {
            color: color(tour.region),
            weight: 3,
            opacity: 0.85,
            lineJoin: 'round',
            interactive: false
        }).addTo(loopLayer);

        // Wide transparent line makes the loop easy to hit
        L.polyline(latLngs, { weight: 16, opacity: 0 })
            .bindTooltip(() => `Tour ${tour.id} · ${tour.stamps.length} Stempel · ca. ${fmt1(tour.km)} km`
                + (isDone(tour) ? ' · erledigt' : ''), { sticky: true })
            .on('click', () => select(tour.id))
            .addTo(loopLayer);

        loopLines.set(tour.id, line);
    });

    const tourOf = new Map();
    plan.tours.forEach(t => t.stamps.forEach(n => tourOf.set(n, t)));

    stampsByNumber.forEach((stamp, number) => {
        const tour = tourOf.get(number);
        const isStamped = stamped.has(number);
        const marker = L.circleMarker([stamp.lat, stamp.lon], {
            radius: isStamped ? 4 : 5.5,
            color: '#FFFFFF',
            weight: 1.5,
            fillColor: isStamped || !tour ? STAMPED_COLOR : color(tour.region),
            fillOpacity: 1
        });
        marker.bindTooltip(
            `<span class="stamp-id">${stamp.id}</span>${escapeHtml(stamp.name)}`
            + (isStamped ? ' · gestempelt' : tour ? ` · Tour ${tour.id}` : '')
        );
        if (tour) marker.on('click', () => select(tour.id));
        marker.addTo(pointLayer);
        stampMarkers.set(number, marker);
    });

    fitTo(plan.tours);
}

function fitTo(tours) {
    const pts = tours.flatMap(t => tourStamps(t).map(s => [s.lat, s.lon]));
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
        const km = tours.reduce((a, t) => a + t.km, 0);
        const count = tours.reduce((a, t) => a + t.stamps.length, 0);

        const sec = document.createElement('section');
        sec.className = 'card region-card';
        sec.dataset.code = region.code;
        sec.style.setProperty('--c', color(region.code));
        sec.innerHTML = `
            <header class="region-head">
                <h3><span class="mono region-code">${region.code}</span> ${escapeHtml(region.name)}</h3>
                <span class="region-sub">${tours.length} Touren · ${count} Stempel · ${Math.round(km)} km · ca. ${tours[0].driveKm} km Anfahrt ab ${escapeHtml(plan.home)}</span>
            </header>
            <div class="table-wrap">
                <table class="tour-table">
                    <thead><tr>
                        <th scope="col">Erledigt</th><th scope="col">Tour</th>
                        <th scope="col" class="r">km</th><th scope="col" class="r">Std.</th><th scope="col" class="r">Hm min.</th>
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
    const seq = tourStamps(tour)
        .map(s => `<span class="seq-stop"><span class="mono">${s.number}</span> ${escapeHtml(s.name)}</span>`)
        .join(' → ');

    tr.innerHTML = `
        <td><input type="checkbox" class="tour-done" aria-label="Tour ${tour.id} erledigt"></td>
        <td class="tour-id mono">${tour.id}</td>
        <td class="r mono">${tour.single ? dash : fmt1(tour.km)}</td>
        <td class="r mono">${tour.single ? dash : fmt1(tour.hours)}</td>
        <td class="r mono">${tour.single ? dash : tour.ascent}</td>
        <td>${tour.single ? '' : `<span class="level lv-${tour.level}">${tour.level}</span><br>`}${tour.tags
            .map(g => `<span class="season" title="${escapeHtml(g.hint)}">${escapeHtml(g.label)}</span>`).join('')}</td>
        <td class="seq">${tour.single ? '<span class="detour-tag">Abstecher</span> ' : ''}${seq}</td>`;

    const cb = tr.querySelector('.tour-done');
    cb.checked = isDone(tour);
    if (tour.done) {
        cb.disabled = true;
        cb.title = 'Bereits absolviert';
    }
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

    plan.tours.forEach(tour => {
        const visible = !regionFilter || tour.region === regionFilter;
        const done = isDone(tour);
        const line = loopLines.get(tour.id);
        const isSel = selectedId === tour.id;
        const dim = !visible || (selectedId && !isSel);
        if (line) {
            // Finished tours stay visible, but dashed so open tours stand out
            line.setStyle({
                weight: isSel ? 5 : 3,
                opacity: dim ? 0.15 : (done && !isSel ? 0.6 : 0.9),
                dashArray: done && !isSel ? '6 7' : null
            });
            if (isSel) line.bringToFront();
        }
        tour.stamps.forEach(n => {
            const m = stampMarkers.get(n);
            if (m) m.setStyle({ opacity: dim ? 0.25 : 1, fillOpacity: dim ? 0.25 : 1 });
        });
    });

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
        row.classList.toggle('done', isDone(plan.tours.find(t => t.id === row.dataset.id)));
    });

    renderStats();
    renderDetail(tour);
}

function renderStats() {
    // Collected = stamped before the plan + every stamp of a finished tour
    const collected = new Set(stamped);
    plan.tours.filter(isDone).forEach(t => t.stamps.forEach(n => collected.add(n)));
    const openStamps = stampsByNumber.size - collected.size;
    const openKm = plan.tours
        .filter(t => !isDone(t))
        .reduce((a, t) => a + t.km, 0);

    el('tourStats').innerHTML = `
        <div class="route-stat"><div class="label">Stempel gesammelt</div><div class="value highlight">${collected.size}</div></div>
        <div class="route-stat"><div class="label">Offene Stempel</div><div class="value">${openStamps}</div></div>
        <div class="route-stat"><div class="label">Rundtouren</div><div class="value">${plan.tours.filter(t => !t.single).length}</div></div>
        <div class="route-stat"><div class="label">km offen, geschätzt</div><div class="value">${Math.round(openKm)}</div></div>
        <div class="route-stat"><div class="label">Touren erledigt</div><div class="value highlight">${plan.tours.filter(isDone).length}</div></div>`;
}

function renderDetail(tour) {
    const detail = el('tourDetail');

    if (!tour) {
        detail.style.removeProperty('--c');
        const tours = regionFilter ? plan.tours.filter(t => t.region === regionFilter) : plan.tours;
        const count = tours.reduce((a, t) => a + t.stamps.length, 0);
        const km = Math.round(tours.reduce((a, t) => a + t.km, 0));
        detail.innerHTML = `
            <h3>${regionFilter ? escapeHtml(regionName(regionFilter)) : 'Tour auswählen'}</h3>
            <p class="hint">${regionFilter
                ? `${tours.length} Touren mit ${count} Stempeln, zusammen etwa ${km} km.`
                : 'Tippe auf eine farbige Runde in der Karte oder auf eine Zeile in der Liste.'}</p>
            <p class="hint">Für Tagesausflüge ab ${escapeHtml(plan.home)} liegen die Regionen A bis C am nächsten. E bis H lohnen sich eher als Wochenende mit Übernachtung.</p>`;
        return;
    }

    const stamps = tourStamps(tour);
    detail.style.setProperty('--c', color(tour.region));

    const meta = tour.single
        ? '<span>Abstecher mit dem Auto</span>'
        : `<span>ca. ${fmt1(tour.km)} km</span><span>ca. ${fmt1(tour.hours)} Std.</span><span>mind. ${tour.ascent} Hm</span><span class="level lv-${tour.level}">${tour.level}</span>`;

    // Round trip: start and end at the first stamp, the others as waypoints
    const ll = s => `${s.lat},${s.lon}`;
    const mapsUrl = tour.single
        ? `https://www.google.com/maps?q=${ll(stamps[0])}`
        : `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${ll(stamps[0])}`
            + `&destination=${ll(stamps[0])}&waypoints=${encodeURIComponent(stamps.slice(1).map(ll).join('|'))}`;

    detail.innerHTML = `
        <span class="region-tag">${escapeHtml(regionName(tour.region))}</span>
        <h3>Tour <span class="mono">${tour.id}</span>${isDone(tour) ? ' <span class="level lv-leicht">✓ erledigt</span>' : ''}</h3>
        <div class="tour-meta mono">${meta}<span>${tour.minEle}–${tour.maxEle} m ü. NN</span><span>${stamps.length} Stempel</span></div>
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
        <div class="detail-actions">
            <button type="button" class="selection-btn primary" id="tourGpx">GPX herunterladen</button>
            <a class="detail-link" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">Google Maps →</a>
            <button type="button" class="detail-clear" id="tourClear">Auswahl aufheben</button>
        </div>`;

    el('tourGpx').addEventListener('click', () => {
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
}
