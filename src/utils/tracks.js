// Real GPX tracks (e.g. from Komoot) for tours in the Tourenplan.
// Two sources: project files in data/tours/<ID>.gpx, and uploads stored in IndexedDB.
// An upload overrides the project file. Own tours (name, GPX, stamps, status) live in IndexedDB as well.

import { parseGPX, parseTrackPoint } from './gpx.js';
import { distanceMeters } from './geo.js';

const DB_NAME = 'hwn-route-compare';
const DB_VERSION = 2;
const STORE = 'tour-gpx';
const OWN_STORE = 'own-tours';

// Stamps further away than this from the track are flagged as missed
export const STAMP_ON_TRACK_METERS = 150;

// Elevation changes smaller than this are treated as GPS noise
const ELEVATION_NOISE_METERS = 3;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        // Version 1 only had the track store; create whatever is missing
        req.onupgradeneeded = () => {
            [STORE, OWN_STORE].forEach(name => {
                if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
            });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function withStore(mode, fn, storeName = STORE) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const result = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(result.result ?? result);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Load all uploaded tracks
 * @returns {Promise<Object>} - {tourId: {name, gpx, uploadedAt}}
 */
export function loadUploadedTracks() {
    return loadAll(STORE);
}

async function loadAll(storeName) {
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const out = {};
            const req = db.transaction(storeName).objectStore(storeName).openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return resolve(out);
                out[cursor.key] = cursor.value;
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    } catch {
        return {};
    }
}

export function saveUploadedTrack(tourId, record) {
    return withStore('readwrite', store => store.put(record, tourId));
}

export function deleteUploadedTrack(tourId) {
    return withStore('readwrite', store => store.delete(tourId));
}

export function clearUploadedTracks() {
    return withStore('readwrite', store => store.clear());
}

/**
 * Own tours, keyed by their id ("own-<timestamp>")
 * @returns {Promise<Array>} - [{id, name, gpx, fileName, stamps, status: 'planned'|'walked', createdAt}]
 */
export async function loadOwnTours() {
    const all = await loadAll(OWN_STORE);
    return Object.values(all).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function saveOwnTour(record) {
    return withStore('readwrite', store => store.put(record, record.id), OWN_STORE);
}

export function deleteOwnTour(id) {
    return withStore('readwrite', store => store.delete(id), OWN_STORE);
}

export function clearOwnTours() {
    return withStore('readwrite', store => store.clear(), OWN_STORE);
}

/**
 * Load project GPX files for the given tours. Missing files are skipped.
 * @param {Array<string>} tourIds
 * @returns {Promise<Object>} - {tourId: {name, gpx}}
 */
export async function loadProjectTracks(tourIds) {
    const out = {};
    await Promise.all(tourIds.map(async id => {
        try {
            const res = await fetch(`./data/tours/${id}.gpx`);
            if (!res.ok) return;
            const gpx = await res.text();
            if (gpx.includes('<gpx')) out[id] = { name: `${id}.gpx`, gpx };
        } catch {
            // no file for this tour
        }
    }));
    return out;
}

/**
 * Split a GPX into its track segments, so a tour walked in several parts
 * (several <trk>/<trkseg> in one file) isn't drawn as one connected line.
 * Falls back to parseGPX() for files with only route or waypoints.
 */
function parseSegments(gpxText) {
    const doc = new DOMParser().parseFromString(gpxText, 'application/xml');
    if (doc.querySelector('parsererror')) {
        throw new Error('GPX konnte nicht gelesen werden – bitte Datei/Inhalt prüfen.');
    }
    const segments = [...doc.querySelectorAll('trkseg')]
        .map(seg => [...seg.querySelectorAll('trkpt')]
            .map(parseTrackPoint)
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)))
        .filter(seg => seg.length >= 2);
    return segments.length ? segments : [parseGPX(gpxText)];
}

function segmentAscent(points) {
    // Small hysteresis so GPS jitter doesn't add up
    const eles = points.map(p => p.elevation).filter(Number.isFinite);
    let ascent = 0;
    let ref = eles[0];
    for (const e of eles) {
        if (e - ref >= ELEVATION_NOISE_METERS) {
            ascent += e - ref;
            ref = e;
        } else if (ref - e >= ELEVATION_NOISE_METERS) {
            ref = e;
        }
    }
    return ascent;
}

/**
 * Parse a GPX text and compute what the Tourenplan needs
 * @param {string} gpxText
 * @param {Array} stamps - Tour stamps {number, lat, lon}
 * @returns {Object} - {latLngs: [[[lat, lon], ...], ...] per segment, km, ascent (null without elevation), maxEle, minEle,
 *                      missed: [{number, distance}]}
 */
export function analyzeTrack(gpxText, stamps) {
    const segments = parseSegments(gpxText);
    const points = segments.flat();
    if (points.length < 2) {
        throw new Error('GPX enthält keinen Track.');
    }

    let meters = 0;
    for (const seg of segments) {
        for (let i = 1; i < seg.length; i++) {
            meters += distanceMeters(seg[i - 1].lat, seg[i - 1].lon, seg[i].lat, seg[i].lon);
        }
    }
    const ascent = segments.reduce((a, seg) => a + segmentAscent(seg), 0);
    const eles = points.map(p => p.elevation).filter(Number.isFinite);

    const missed = stamps
        .map(s => ({
            number: s.number,
            distance: Math.min(...points.map(p => distanceMeters(s.lat, s.lon, p.lat, p.lon)))
        }))
        .filter(s => s.distance > STAMP_ON_TRACK_METERS);

    return {
        latLngs: segments.map(seg => seg.map(p => [p.lat, p.lon])),
        km: meters / 1000,
        // Planning exports (e.g. routes without <ele>) have no elevation: null, not 0
        ascent: eles.length ? Math.round(ascent) : null,
        maxEle: eles.length ? Math.round(Math.max(...eles)) : null,
        minEle: eles.length ? Math.round(Math.min(...eles)) : null,
        missed
    };
}

/**
 * Distance of every stamp to a GPX track, ordered by where the track passes the stamp.
 * @param {string} gpxText
 * @param {Array} stamps - All stamps {number, lat, lon}
 * @returns {Array<{number, distance, index}>} - index = closest track point (for the order along the track)
 */
export function stampsAlongTrack(gpxText, stamps) {
    const points = parseSegments(gpxText).flat();
    if (points.length < 2) {
        throw new Error('GPX enthält keinen Track.');
    }
    return stamps
        .map(s => {
            let best = { distance: Infinity, index: 0 };
            points.forEach((p, index) => {
                const distance = distanceMeters(s.lat, s.lon, p.lat, p.lon);
                if (distance < best.distance) best = { distance, index };
            });
            return { number: s.number, distance: best.distance, index: best.index };
        })
        .sort((a, b) => a.index - b.index || a.distance - b.distance);
}

// Points closer than this to an earlier part of the track count as walked twice ...
const BACKTRACK_METERS = 25;
// ... unless that earlier part is only this far back (a bend, not the way back)
const BACKTRACK_MIN_GAP_METERS = 400;

/**
 * Where a track could be improved: the walking distance between consecutive stamps (in track order)
 * and the share of the track that runs back on itself.
 * @param {Array} latLngs - [[[lat, lon], ...], ...] per segment, as returned by analyzeTrack()
 * @param {Array} stamps - Tour stamps {number, lat, lon}
 * @returns {Object} - {points: [[lat, lon]], legs: [{from, to, trackKm, lineKm, startIndex, endIndex}], backtrackShare}
 *                     a leg's indices refer to points; the closing leg wraps around (endIndex < startIndex)
 */
export function reviewTrack(latLngs, stamps) {
    const points = latLngs.flat();
    const cum = [0];
    for (let i = 1; i < points.length; i++) {
        cum.push(cum[i - 1] + distanceMeters(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]));
    }
    const total = cum.at(-1) || 1;

    const nearest = stamps.map(s => {
        let best = { number: s.number, index: 0, distance: Infinity };
        points.forEach((p, index) => {
            const distance = distanceMeters(s.lat, s.lon, p[0], p[1]);
            if (distance < best.distance) best = { number: s.number, index, distance };
        });
        return best;
    }).sort((a, b) => a.index - b.index);

    const byNumber = new Map(stamps.map(s => [s.number, s]));
    const legs = nearest.length < 2 ? [] : nearest.map((a, k) => {
        const b = nearest[(k + 1) % nearest.length];
        const wraps = k === nearest.length - 1;
        const meters = wraps ? total - cum[a.index] + cum[b.index] : cum[b.index] - cum[a.index];
        const sa = byNumber.get(a.number);
        const sb = byNumber.get(b.number);
        return {
            from: a.number, to: b.number,
            trackKm: meters / 1000,
            lineKm: distanceMeters(sa.lat, sa.lon, sb.lat, sb.lon) / 1000,
            startIndex: a.index, endIndex: b.index
        };
    });

    // Grid of ~30 m cells, so each point is only compared with its neighbourhood
    const cell = ([lat, lon]) => `${Math.floor(lat / 0.00027)}:${Math.floor(lon / 0.00043)}`;
    const grid = new Map();
    let doubled = 0;
    points.forEach((p, i) => {
        const [cy, cx] = cell(p).split(':').map(Number);
        let again = false;
        for (let dy = -1; dy <= 1 && !again; dy++) {
            for (let dx = -1; dx <= 1 && !again; dx++) {
                for (const j of grid.get(`${cy + dy}:${cx + dx}`) || []) {
                    if (cum[i] - cum[j] >= BACKTRACK_MIN_GAP_METERS
                        && distanceMeters(p[0], p[1], points[j][0], points[j][1]) < BACKTRACK_METERS) {
                        again = true;
                        break;
                    }
                }
            }
        }
        if (again && i > 0) doubled += cum[i] - cum[i - 1];
        const key = cell(p);
        grid.set(key, [...(grid.get(key) || []), i]);
    });

    return { points, legs, backtrackShare: doubled / total };
}

// Name stored in the GPX (metadata or first track/route), if any
export function gpxName(gpxText) {
    const doc = new DOMParser().parseFromString(gpxText, 'application/xml');
    const node = doc.querySelector('metadata > name, trk > name, rte > name');
    return node?.textContent.trim() || '';
}

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Build a GPX track from [lon, lat, ele?] coordinates (e.g. an OpenRouteService GeoJSON line)
 * @param {string} name
 * @param {Array} coordinates
 * @returns {string} GPX text
 */
export function coordinatesToGPX(name, coordinates) {
    const points = coordinates.map(([lon, lat, ele]) =>
        `            <trkpt lat="${lat}" lon="${lon}">${Number.isFinite(ele) ? `<ele>${ele}</ele>` : ''}</trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="HWN Route Compare (OpenRouteService)" xmlns="http://www.topografix.com/GPX/1/1">
    <metadata>
        <name>${escapeXml(name)}</name>
    </metadata>
    <trk>
        <name>${escapeXml(name)}</name>
        <trkseg>
${points}
        </trkseg>
    </trk>
</gpx>
`;
}
