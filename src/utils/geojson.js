// GeoJSON conversion utilities
// Converts between internal format and GeoJSON standard

/**
 * Convert a GeoJSON FeatureCollection of Points to internal stamp format
 * @param {Object} geojson - GeoJSON FeatureCollection
 * @returns {Array} - Array of {id, number, name, description, lat, lon, elevation}
 */
export function stampsFromGeoJSON(geojson) {
    if (!geojson || geojson.type !== 'FeatureCollection') {
        throw new Error('Invalid GeoJSON: expected FeatureCollection');
    }

    return geojson.features.map(feature => {
        const coords = feature.geometry.coordinates;
        const props = feature.properties;

        return {
            id: props.id,
            number: props.number,
            name: props.name,
            description: props.description,
            lon: coords[0],
            lat: coords[1],
            elevation: coords[2] || props.elevation || null
        };
    });
}

/**
 * Convert internal stamp array to GeoJSON FeatureCollection
 * @param {Array} stamps - Array of {id, number, name, description, lat, lon, elevation}
 * @returns {Object} - GeoJSON FeatureCollection
 */
export function stampsToGeoJSON(stamps) {
    return {
        type: 'FeatureCollection',
        features: stamps.map(stamp => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: stamp.elevation
                    ? [stamp.lon, stamp.lat, stamp.elevation]
                    : [stamp.lon, stamp.lat]
            },
            properties: {
                id: stamp.id,
                number: stamp.number,
                name: stamp.name,
                description: stamp.description
            }
        }))
    };
}

/**
 * Convert GPX route points to GeoJSON LineString Feature
 * @param {Array} routePoints - Array of {lat, lon, elevation?}
 * @param {Object} metadata - Optional metadata {name, source}
 * @returns {Object} - GeoJSON Feature with LineString geometry
 */
export function routeToGeoJSON(routePoints, metadata = {}) {
    const coordinates = routePoints.map(p =>
        p.elevation !== undefined
            ? [p.lon, p.lat, p.elevation]
            : [p.lon, p.lat]
    );

    return {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates
        },
        properties: {
            name: metadata.name || 'Route',
            source: metadata.source || 'gpx',
            pointCount: routePoints.length
        }
    };
}

/**
 * Convert GeoJSON LineString to internal route format
 * @param {Object} geojson - GeoJSON Feature with LineString geometry
 * @returns {Array} - Array of {lat, lon, elevation?}
 */
export function routeFromGeoJSON(geojson) {
    if (!geojson || geojson.geometry?.type !== 'LineString') {
        throw new Error('Invalid GeoJSON: expected LineString Feature');
    }

    return geojson.geometry.coordinates.map(coord => ({
        lon: coord[0],
        lat: coord[1],
        ...(coord[2] !== undefined && { elevation: coord[2] })
    }));
}

/**
 * Create a GeoJSON Point Feature from coordinates
 * @param {number} lat
 * @param {number} lon
 * @param {Object} properties - Optional properties
 * @returns {Object} - GeoJSON Point Feature
 */
export function pointToGeoJSON(lat, lon, properties = {}) {
    return {
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [lon, lat]
        },
        properties
    };
}

/**
 * Create a GeoJSON LineString Feature from two points (for detour lines)
 * @param {Object} from - {lat, lon}
 * @param {Object} to - {lat, lon}
 * @param {Object} properties - Optional properties
 * @returns {Object} - GeoJSON LineString Feature
 */
export function lineToGeoJSON(from, to, properties = {}) {
    return {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                [from.lon, from.lat],
                [to.lon, to.lat]
            ]
        },
        properties
    };
}
