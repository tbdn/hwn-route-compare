// Routing API integration for actual trail distances
// Uses OpenRouteService (free tier: 2000 requests/day)
// User must provide their own API key

const ORS_BASE_URL = 'https://api.openrouteservice.org/v2/directions/foot-hiking';
const CACHE_KEY = 'hwn-routing-cache';
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
 * @returns {Promise<Object>} - { distance, duration, geometry, error }
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

    try {
        // Request round-trip route: exit → stamp → exit
        const coordinates = [
            [exitPoint.lon, exitPoint.lat],
            [stamp.lon, stamp.lat],
            [exitPoint.lon, exitPoint.lat]
        ];

        const response = await fetch(ORS_BASE_URL, {
            method: 'POST',
            headers: {
                'Authorization': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                coordinates,
                elevation: true,
                instructions: false
            })
        });

        if (!response.ok) {
            if (response.status === 401) {
                return { error: 'Ungültiger API-Schlüssel' };
            }
            if (response.status === 429) {
                return { error: 'API-Limit erreicht (max. 2000/Tag)' };
            }
            if (response.status === 404) {
                return { error: 'Keine Route gefunden (Stempel evtl. nicht erreichbar)' };
            }
            return { error: `API-Fehler: ${response.status}` };
        }

        const data = await response.json();
        const route = data.routes?.[0];

        if (!route) {
            return { error: 'Keine Route gefunden' };
        }

        const result = {
            // Total round-trip distance in meters
            distance: Math.round(route.summary.distance),
            // Total duration in seconds
            duration: Math.round(route.summary.duration),
            // Elevation gain in meters
            ascent: Math.round(route.summary.ascent || 0),
            descent: Math.round(route.summary.descent || 0),
            // GeoJSON geometry for map display
            geometry: route.geometry
        };

        // Cache the result
        saveToCache(key, result);

        return result;

    } catch (err) {
        if (err.name === 'TypeError' && err.message.includes('fetch')) {
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
    } catch {
        // ignore
    }
}
