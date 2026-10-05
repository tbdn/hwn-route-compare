// Browser environment for the tests: the real src/index.html in linkedom, an in-memory IndexedDB,
// localStorage, a Leaflet stub and fetch() serving files from src/ (plus an optional OpenRouteService mock).
// Every test file runs in its own process (node --test), so each file gets a fresh app.
// Call setupBrowser() before importing any module from src/.

import 'fake-indexeddb/auto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML, DOMParser } from 'linkedom';

export const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

export const readJSON = file => JSON.parse(fs.readFileSync(SRC + file, 'utf8'));

// All stamps in the app's internal format
export const stamps = readJSON('data/stamps.geojson').features.map(f => ({
    number: f.properties.number,
    id: f.properties.id,
    name: f.properties.name,
    description: f.properties.description,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    elevation: f.geometry.coordinates[2]
}));
export const stampByNumber = new Map(stamps.map(s => [s.number, s]));
export const plan = readJSON('data/tours.json');
export const tourById = id => plan.tours.find(t => t.id === id);

/**
 * @param {Object} options
 * @param {Object} options.storage - initial localStorage content
 * @returns {Object} - { store, drawnLines, ors: {calls, lastBody, mode} }
 */
export function setupBrowser({ storage = {} } = {}) {
    const html = fs.readFileSync(SRC + 'index.html', 'utf8').replace(/<script[^]*?<\/script>/g, '');
    const { document, window } = parseHTML(html);
    globalThis.document = document;
    globalThis.window = window;
    globalThis.DOMParser = DOMParser;
    globalThis.Event = window.Event;
    globalThis.CustomEvent = window.CustomEvent;
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.scrollTo = () => {};
    globalThis.location = { hash: '', pathname: '/', search: '' };
    globalThis.history = { replaceState: (state, title, url) => { location.hash = url?.startsWith('#') ? url : ''; } };
    globalThis.confirm = () => true;

    // Leaflet: every call chains; polylines are recorded so tests can check what was drawn
    const drawnLines = [];
    const chain = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : chain(), apply: () => chain() });
    globalThis.L = new Proxy({}, {
        get: (t, k) => k === 'polyline'
            ? (points, options) => { drawnLines.push({ points, options }); return chain(); }
            : chain()
    });

    const store = { ...storage };
    globalThis.localStorage = {
        getItem: k => store[k] ?? null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
    };

    // Downloads (progress export, GPX) end up here instead of a file
    const downloads = [];
    globalThis.Blob = class { constructor(parts) { downloads.push(parts.join('')); } };
    URL.createObjectURL = () => 'blob:';
    URL.revokeObjectURL = () => {};

    // OpenRouteService: densifies the requested waypoints into a line with elevation
    const ors = { calls: [], mode: 'ok' };
    globalThis.fetch = async (url, opts) => {
        if (url.includes('openrouteservice')) {
            const body = JSON.parse(opts.body);
            ors.calls.push({ url, body });
            if (ors.mode === '404') {
                return { ok: false, status: 404, json: async () => ({ error: { code: 2010, message: 'Could not find routable point within a radius of 350.0 meters' } }) };
            }
            const c = body.coordinates;
            const coords = [];
            for (let i = 0; i < c.length - 1; i++) {
                for (let k = 0; k < 10; k++) {
                    const t = k / 10;
                    coords.push([c[i][0] + (c[i + 1][0] - c[i][0]) * t, c[i][1] + (c[i + 1][1] - c[i][1]) * t, 400 + 20 * i + 5 * k]);
                }
            }
            coords.push([...c.at(-1), 400]);
            return {
                ok: true,
                json: async () => ({
                    type: 'FeatureCollection',
                    features: [{ geometry: { type: 'LineString', coordinates: coords }, properties: { summary: { distance: 4321, duration: 3600 } } }]
                })
            };
        }
        const file = SRC + url.replace(/^\.\//, '');
        if (!fs.existsSync(file)) return { ok: false, status: 404 };
        return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')), text: async () => fs.readFileSync(file, 'utf8') };
    };

    return { store, drawnLines, downloads, ors };
}

// --- DOM helpers ---

export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];
export const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
export const text = node => node?.textContent.replace(/\s+/g, ' ').trim() ?? '';

// linkedom does not reflect the checked attribute into the property, so set it like a click would
export function setChecked(input, checked) {
    input.checked = checked;
    input.dispatchEvent(new Event('change'));
}

// Rendered checkboxes: the attribute holds the state that was rendered
export const isRenderedChecked = input => input.hasAttribute('checked');

export const row = id => $(`.tour-row[data-id="${id}"]`);

export function rowState(id) {
    const cb = row(id).querySelector('.tour-done');
    return { checked: !!cb.checked, partial: !!cb.indeterminate, count: row(id).querySelector('.done-count').textContent };
}

// Figures of a list row: km, hours, ascent (text as shown)
export function rowCells(id) {
    const [km, hours, ascent] = [...row(id).querySelectorAll('td')].slice(2, 5).map(td => td.textContent.trim());
    return { km, hours, ascent };
}

export const parseDe = value => Number(String(value).replace(/[~≥]/g, '').replace(/\./g, '').replace(',', '.'));

// Statistics as {label: text}
export function stats() {
    return Object.fromEntries($$('#tourStats .route-stat').map(d => [d.querySelector('.label').textContent, d.querySelector('.value').textContent]));
}

// Choose a file in a hidden <input type="file">
export async function pickFile(input, name, content) {
    Object.defineProperty(input, 'files', { value: [{ name, text: async () => content }], configurable: true });
    input.dispatchEvent(new Event('change'));
    await tick();
}

// Import a progress file through the "Importieren" button
export async function importProgressFile(content) {
    globalThis.FileReader = class { readAsText() { this.result = content; this.onload(); } };
    Object.defineProperty($('#progressFile'), 'files', { value: [{}], configurable: true });
    $('#progressFile').dispatchEvent(new Event('change'));
    await tick();
}

/**
 * Closed GPX track through the given stamps (straight lines, 30 points per leg, with elevation)
 * @param {Array<number>} numbers - stamp numbers
 * @param {string} name - optional <metadata><name>
 */
export function loopGpx(numbers, name = '') {
    const pts = [...numbers, numbers[0]].map(n => stampByNumber.get(n));
    let trk = '';
    for (let i = 0; i < pts.length - 1; i++) {
        for (let k = 0; k < 30; k++) {
            const a = pts[i];
            const b = pts[i + 1];
            const t = k / 30;
            trk += `<trkpt lat="${a.lat + (b.lat - a.lat) * t}" lon="${a.lon + (b.lon - a.lon) * t}"><ele>${a.elevation + (b.elevation - a.elevation) * t}</ele></trkpt>`;
        }
    }
    return `<?xml version="1.0"?><gpx>${name ? `<metadata><name>${name}</name></metadata>` : ''}<trk><trkseg>${trk}</trkseg></trk></gpx>`;
}

// Start the tour plan like app.js does when the tab is opened
export async function startTourPlan() {
    const mod = await import(SRC + 'components/tourplan.js');
    await mod.showTourPlan(stamps);
    await tick();
    return mod;
}
