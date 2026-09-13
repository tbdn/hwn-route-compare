// Load HWN stamp data from GeoJSON
import { stampsFromGeoJSON } from './geojson.js';

/**
 * Load stamps from GeoJSON file and convert to internal format
 * @returns {Promise<Array>} - Array of {id, number, name, description, lat, lon, elevation}
 */
export async function loadStamps() {
    const response = await fetch("./data/stamps.geojson");
    if (!response.ok) {
        throw new Error("Konnte Stempeldaten nicht laden");
    }
    const geojson = await response.json();
    return stampsFromGeoJSON(geojson);
}

/**
 * Load raw GeoJSON without conversion (for direct map use)
 * @returns {Promise<Object>} - GeoJSON FeatureCollection
 */
export async function loadStampsGeoJSON() {
    const response = await fetch("./data/stamps.geojson");
    if (!response.ok) {
        throw new Error("Konnte Stempeldaten nicht laden");
    }
    return response.json();
}
