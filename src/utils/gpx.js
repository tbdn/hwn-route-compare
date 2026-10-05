import { routeToGeoJSON } from './geojson.js';

// Parse GPX track/route points (e.g., from Komoot)
export function parseTrackPoint(trackPoint) {
    const lat = parseFloat(trackPoint.getAttribute("lat"));
    const lon = parseFloat(trackPoint.getAttribute("lon"));

    const elevationElement = trackPoint.querySelector("ele");
    const elevation = elevationElement
        ? parseFloat(elevationElement.textContent)
        : null;

    const timeElement = trackPoint.querySelector("time");
    const time = timeElement ? timeElement.textContent : null;

    return { lat, lon, elevation, time };
}

export function parseGPX(gpxText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxText, "application/xml");

    const parserError = doc.querySelector("parsererror");
    if (parserError) {
        throw new Error("GPX konnte nicht gelesen werden – bitte Datei/Inhalt prüfen.");
    }

    // Try trkpt first, then rtept, then wpt
    let points = [...doc.querySelectorAll("trkpt")];
    if (!points.length) points = [...doc.querySelectorAll("rtept")];
    if (!points.length) points = [...doc.querySelectorAll("wpt")];

    return points
        .map(parseTrackPoint)
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

// Parse HWN stamp waypoints from GPX
export function parseStampsGPX(gpxText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxText, "application/xml");

    const parserError = doc.querySelector("parsererror");
    if (parserError) {
        throw new Error("Invalid GPX file");
    }

    const waypoints = [...doc.querySelectorAll("wpt")];
    return waypoints.map(parseStampWaypoint).filter(s => s.lat && s.lon);
}

function parseStampWaypoint(wpt) {
    const lat = parseFloat(wpt.getAttribute("lat"));
    const lon = parseFloat(wpt.getAttribute("lon"));

    const name = getElementText(wpt, "name");
    const description = getElementText(wpt, "desc");
    const elevation = getElementNumber(wpt, "ele");

    // Parse "HWN001 Eckertalsperre" format
    const match = name?.match(/^HWN(\d+)\s+(.+)$/);

    return {
        id: match ? `HWN${match[1]}` : null,
        number: match ? parseInt(match[1], 10) : null,
        name: match ? match[2] : name,
        description,
        lat,
        lon,
        elevation
    };
}

function getElementText(parent, selector) {
    return parent.querySelector(selector)?.textContent.trim() ?? null;
}

function getElementNumber(parent, selector) {
    const text = getElementText(parent, selector);
    return text === null ? null : parseFloat(text);
}

/**
 * Parse GPX and return as GeoJSON LineString Feature
 * @param {string} gpxText - GPX file content
 * @param {Object} metadata - Optional metadata {name, source}
 * @returns {Object} - GeoJSON Feature with LineString geometry
 */
export function gpxToGeoJSON(gpxText, metadata = {}) {
    const points = parseGPX(gpxText);
    return routeToGeoJSON(points, metadata);
}
