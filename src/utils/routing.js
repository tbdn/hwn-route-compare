// Routing API integration for actual trail distances
// Uses OpenRouteService (free tier: 2000 requests/day)
// User must provide their own API key

const ORS_BASE_URL = 'https://api.openrouteservice.org/v2/directions/foot-hiking';
// v2: geometry is stored as [lat, lon] points; older entries held encoded polylines
const CACHE_KEY = 'hwn-routing-cache-v2';
const LEGACY_CACHE_KEY = 'hwn-routing-cache';
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

let apiKey = null;

/**
 * Set the OpenRouteService API key
 * @param {string} key - API key from openrouteservice.org
 */
export function setApiKey(key) {
    apiKey = key?.trim() || null;
}

/**
 * Check if API key is configured
 * @returns {boolean}
 */
export function hasApiKey() {
    return !!apiKey;
}

/**
 * Load cached routing results from localStorage
 * @returns {Object} - cache object { stampId_exitLat_exitLon: { result, timestamp } }
 */
function loadCache() {
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        return cached ? JSON.parse(cached) : {};
    } catch {
        return {};
    }
}

/**
 * Save routing result to cache
 * @param {string} key - cache key
 * @param {Object} result - routing result
 */
function saveToCache(key, result) {
    try {
        localStorage.removeItem(LEGACY_CACHE_KEY);
        const cache = loadCache();
        cache[key] = {
            result,
            timestamp: Date.now()
        };
        // Clean old entries
        const now = Date.now();
        for (const k of Object.keys(cache)) {
            if (now - cache[k].timestamp > CACHE_EXPIRY_MS) {
                delete cache[k];
            }
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
        // localStorage might be full, ignore
    }
}

/**
 * Get cached result if available and not expired
 * @param {string} key - cache key
 * @returns {Object|null} - cached result or null
 */
function getFromCache(key) {
    const cache = loadCache();
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_EXPIRY_MS) return null;
    return entry.result;
}

/**
 * Generate cache key for a routing request
 */
function cacheKey(exitPoint, stamp) {
    return `${stamp.id}_${exitPoint.lat.toFixed(5)}_${exitPoint.lon.toFixed(5)}`;
}

/**
 * Calculate actual walking route from exit point to stamp and back
 * @param {Object} exitPoint - { lat, lon }
 * @param {Object} stamp - { lat, lon, id, ... }
 * @returns {Promise<Object>} - { distance, duration, ascent, descent, geometry: [[lat, lon], ...], error }
 */
export async function calculateDetourRoute(exitPoint, stamp) {
    if (!apiKey) {
        return { error: 'API-Schlüssel nicht konfiguriert' };
    }

    // Check cache first
    const key = cacheKey(exitPoint, stamp);
    const cached = getFromCache(key);
    if (cached) {
        return { ...cached, fromCache: true };
    }

    // Round-trip route: exit → stamp → exit
    const route = await requestRoute([exitPoint, stamp, exitPoint]);
    if (route.error) return route;

    const result = {
        // Total round-trip distance in meters, duration in seconds
        distance: route.distance,
        duration: route.duration,
        ascent: route.ascent,
        descent: route.descent,
        // [lat, lon] points for map display
        geometry: toLatLngs(route.coordinates)
    };
    saveToCache(key, result);
    return result;
}

const toLatLngs = coordinates => coordinates.map(([lon, lat]) => [lat, lon]);

// Climbs and descents from [lon, lat, ele] points, for responses without a summary
function elevationChange(coordinates) {
    let ascent = 0;
    let descent = 0;
    for (let i = 1; i < coordinates.length; i++) {
        const diff = (coordinates[i][2] ?? 0) - (coordinates[i - 1][2] ?? 0);
        if (diff > 0) ascent += diff;
        else descent -= diff;
    }
    return { ascent, descent };
}

/**
 * Hiking route through waypoints via the GeoJSON endpoint. It returns plain coordinates;
 * the JSON endpoint encodes them as a polyline that holds a third value once elevation is requested.
 * @param {Array} waypoints - {lat, lon} points in walking order
 * @returns {Promise<Object>} - { distance, duration, ascent, descent, coordinates: [[lon, lat, ele], ...] } or { error }
 */
async function requestRoute(waypoints) {
    if (!apiKey) {
        return { error: 'API-Schlüssel nicht konfiguriert' };
    }
    if (waypoints.length < 2) {
        return { error: 'Mindestens 2 Wegpunkte erforderlich' };
    }

    try {
        const response = await fetch(`${ORS_BASE_URL}/geojson`, {
            method: 'POST',
            headers: {
                'Authorization': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                coordinates: waypoints.map(p => [p.lon, p.lat]),
                elevation: true,
                instructions: false
            })
        });

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return { error: 'Ungültiger API-Schlüssel' };
            }
            if (response.status === 429) {
                return { error: 'API-Limit erreicht (max. 2000/Tag)' };
            }
            // ORS explains unroutable points (e.g. no path within 350 m) in the body
            const message = await response.json().then(d => d?.error?.message).catch(() => null);
            if (message) return { error: `Keine Route gefunden: ${message}` };
            return { error: response.status === 404 ? 'Keine Route gefunden' : `API-Fehler: ${response.status}` };
        }

        const data = await response.json();
        const feature = data.features?.[0];
        if (!feature?.geometry?.coordinates?.length) {
            return { error: 'Keine Route gefunden' };
        }

        const props = feature.properties || {};
        const summary = props.summary || {};
        const fallback = elevationChange(feature.geometry.coordinates);
        return {
            distance: Math.round(summary.distance || 0),
            duration: Math.round(summary.duration || 0),
            ascent: Math.round(props.ascent ?? summary.ascent ?? fallback.ascent),
            descent: Math.round(props.descent ?? summary.descent ?? fallback.descent),
            coordinates: feature.geometry.coordinates
        };
    } catch (err) {
        if (err.name === 'TypeError') {
            return { error: 'Netzwerkfehler - keine Verbindung zur API' };
        }
        return { error: err.message || 'Unbekannter Fehler' };
    }
}

/**
 * Format duration for display
 * @param {number} seconds
 * @returns {string} - e.g., "12 min" or "1h 15min"
 */
export function formatDuration(seconds) {
    if (seconds < 60) return '< 1 min';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return remainingMins > 0 ? `${hours}h ${remainingMins}min` : `${hours}h`;
}

/**
 * Format distance for display
 * @param {number} meters
 * @returns {string} - e.g., "450 m" or "1.2 km"
 */
export function formatDistance(meters) {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Clear all cached routing results
 */
export function clearCache() {
    try {
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(LEGACY_CACHE_KEY);
    } catch {
        // ignore
    }
}

/**
 * Calculate a hiking route through waypoints as plain coordinates (GeoJSON endpoint),
 * so the result can be stored as a GPX track
 * @param {Array} waypoints - Array of {lat, lon} points in walking order (repeat the first one to close a loop)
 * @returns {Promise<Object>} - { distance, ascent, coordinates: [[lon, lat, ele], ...], error }
 */
export async function calculateHikingTrack(waypoints) {
    const route = await requestRoute(waypoints);
    if (route.error) return route;
    return { distance: route.distance, ascent: route.ascent, coordinates: route.coordinates };
}

/**
 * Calculate a route through multiple waypoints
 * @param {Array} waypoints - Array of {lat, lon} points (start, stamps..., end)
 * @returns {Promise<Object>} - { distance, duration, ascent, descent, geometry: [[lat, lon], ...], coordinates, error }
 */
export async function calculateMultiWaypointRoute(waypoints) {
    const route = await requestRoute(waypoints);
    if (route.error) return route;
    return {
        distance: route.distance,
        duration: route.duration,
        ascent: route.ascent,
        descent: route.descent,
        // [lat, lon] points for the map; coordinates ([lon, lat, ele]) for a GPX track
        geometry: toLatLngs(route.coordinates),
        coordinates: route.coordinates
    };
}
