// Real GPX tracks (e.g. from Komoot) for tours in the Tourenplan.
// Two sources: project files in data/tours/<ID>.gpx, and uploads stored in IndexedDB.
// An upload overrides the project file.

import { parseGPX, parseTrackPoint } from './gpx.js';
import { distanceMeters } from './geo.js';

const DB_NAME = 'hwn-route-compare';
const STORE = 'tour-gpx';

// Stamps further away than this from the track are flagged as missed
export const STAMP_ON_TRACK_METERS = 150;

// Elevation changes smaller than this are treated as GPS noise
const ELEVATION_NOISE_METERS = 3;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function withStore(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const result = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(result.result ?? result);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Load all uploaded tracks
 * @returns {Promise<Object>} - {tourId: {name, gpx, uploadedAt}}
 */
export async function loadUploadedTracks() {
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const out = {};
            const req = db.transaction(STORE).objectStore(STORE).openCursor();
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
