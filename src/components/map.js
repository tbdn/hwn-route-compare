// Map component using Leaflet
// Centered on the Harz region by default

const HARZ_CENTER = [51.75, 10.65];
const DEFAULT_ZOOM = 10;

let map = null;
let routeLayer = null;
let stampsLayer = null;
let matchedLayer = null;
let detourLayer = null;
let routingLayer = null;
let extendedRouteLayer = null;

// Custom marker icons
const defaultStampIcon = L.divIcon({
    className: 'stamp-marker',
    html: '<div class="marker-dot"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6]
});

const matchedStampIcon = L.divIcon({
    className: 'stamp-marker matched',
    html: '<div class="marker-dot"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
});

const exitPointIcon = L.divIcon({
    className: 'exit-point-marker',
    html: '<div class="exit-dot"></div>',
    iconSize: [10, 10],
    iconAnchor: [5, 5]
});

export function initMap(containerId = 'map') {
    if (map) {
        return map;
    }

    map = L.map(containerId).setView(HARZ_CENTER, DEFAULT_ZOOM);

    // OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    // Initialize layer groups (order matters for z-index)
    routeLayer = L.layerGroup().addTo(map);
    extendedRouteLayer = L.layerGroup().addTo(map);
    detourLayer = L.layerGroup().addTo(map);
    routingLayer = L.layerGroup().addTo(map);
    stampsLayer = L.layerGroup().addTo(map);
    matchedLayer = L.layerGroup().addTo(map);

    return map;
}

export function clearMap() {
    if (routeLayer) routeLayer.clearLayers();
    if (stampsLayer) stampsLayer.clearLayers();
    if (matchedLayer) matchedLayer.clearLayers();
    if (detourLayer) detourLayer.clearLayers();
    if (routingLayer) routingLayer.clearLayers();
    if (extendedRouteLayer) extendedRouteLayer.clearLayers();
}

export function displayRoute(routePoints) {
    if (!map || !routeLayer) return;

    routeLayer.clearLayers();

    if (!routePoints || routePoints.length === 0) return;

    // Convert to [lat, lon] format for Leaflet
    const latLngs = routePoints.map(p => [p.lat, p.lon]);

    const polyline = L.polyline(latLngs, {
        color: '#3D3563',
        weight: 4,
        opacity: 0.8,
        lineCap: 'round',
        lineJoin: 'round'
    });

    routeLayer.addLayer(polyline);

    // Fit map to route bounds
    map.fitBounds(polyline.getBounds(), { padding: [30, 30] });
}

export function displayAllStamps(stamps) {
    if (!map || !stampsLayer) return;

    stampsLayer.clearLayers();

    stamps.forEach(stamp => {
        const marker = L.marker([stamp.lat, stamp.lon], {
            icon: defaultStampIcon,
            title: stamp.name
        });

        marker.bindPopup(createPopupContent(stamp));
        stampsLayer.addLayer(marker);
    });
}

export function displayMatchedStamps(matchedStamps, onMarkerClick) {
    if (!map || !matchedLayer) return;

    matchedLayer.clearLayers();

    matchedStamps.forEach(stamp => {
        const marker = L.marker([stamp.lat, stamp.lon], {
            icon: matchedStampIcon,
            title: stamp.name,
            zIndexOffset: 1000
        });

        marker.bindPopup(createPopupContent(stamp, true));

        if (onMarkerClick) {
            marker.on('click', () => onMarkerClick(stamp));
        }

        matchedLayer.addLayer(marker);
    });
}

export function displayDetourLines(matchedStamps) {
    if (!map || !detourLayer) return;

    detourLayer.clearLayers();

    matchedStamps.forEach(stamp => {
        if (!stamp.exitPoint) return;

        // Determine line color based on detour effort
        const detourDist = stamp.detourDistance || stamp.distance * 2;
        let lineColor;
        if (detourDist < 200) {
            lineColor = '#5C7A5E'; // green (easy)
        } else if (detourDist < 600) {
            lineColor = '#B68A34'; // amber (moderate)
        } else {
            lineColor = '#B65A34'; // rust (significant)
        }

        // Draw dashed line from exit point to stamp
        const detourLine = L.polyline(
            [
                [stamp.exitPoint.lat, stamp.exitPoint.lon],
                [stamp.lat, stamp.lon]
            ],
            {
                color: lineColor,
                weight: 2,
                opacity: 0.7,
                dashArray: '6, 8',
                lineCap: 'round'
            }
        );

        detourLayer.addLayer(detourLine);

        // Add exit point marker
        const exitMarker = L.marker(
            [stamp.exitPoint.lat, stamp.exitPoint.lon],
            {
                icon: exitPointIcon,
                title: `Abzweig für ${stamp.name}`
            }
        );

        exitMarker.bindPopup(`
            <strong>Abzweig</strong>
            <div style="margin-top:4px;">Hier Route verlassen für:</div>
            <div style="font-weight:500;">${stamp.name}</div>
            <div style="margin-top:4px; color:#666;">${Math.round(stamp.distance)} m bis zum Stempel</div>
        `);

        detourLayer.addLayer(exitMarker);
    });
}

export function panToStamp(stamp, zoom = 15) {
    if (!map) return;
    map.setView([stamp.lat, stamp.lon], zoom);
}

function createPopupContent(stamp, showDistance = false) {
    let html = `
        <span class="stamp-id">${stamp.id || '#'}</span>
        <strong>${stamp.name}</strong>
    `;

    if (stamp.description && stamp.description !== stamp.name) {
        html += `<div style="color:#666; margin-top:4px;">${stamp.description}</div>`;
    }

    if (showDistance && stamp.distance !== undefined) {
        html += `<div style="margin-top:6px; font-weight:500;">${Math.round(stamp.distance)} m entfernt</div>`;

        if (stamp.detourDistance !== undefined) {
            const detourText = stamp.detourDistance < 1000
                ? `+${Math.round(stamp.detourDistance)} m`
                : `+${(stamp.detourDistance / 1000).toFixed(1)} km`;
            html += `<div style="color:#666;">Umweg: ${detourText}</div>`;
        }
    }

    return html;
}

export function getMap() {
    return map;
}

/**
 * Display a calculated routing result on the map
 * @param {Object} stamp - The stamp with routing data
 * @param {Array} geometry - [lat, lon] points of the walking route
 */
export function displayRoutingResult(stamp, geometry) {
    if (!map || !routingLayer || !Array.isArray(geometry)) return;

    const points = geometry;
    if (!points.length) return;

    // Draw the actual walking route
    const routeLine = L.polyline(points, {
        color: '#2D7A4D',
        weight: 3,
        opacity: 0.85,
        dashArray: null,
        lineCap: 'round',
        lineJoin: 'round'
    });

    routeLine.bindPopup(`
        <strong>Wanderweg zu ${stamp.name}</strong>
        <div style="margin-top:4px;">Berechneter Umweg via Wanderwege</div>
    `);

    routingLayer.addLayer(routeLine);
}

/**
 * Clear only routing layer (for re-calculations)
 */
export function clearRoutingLayer() {
    if (routingLayer) routingLayer.clearLayers();
}

/**
 * Display an extended route on the map (route through selected stamps)
 * @param {Array} geometry - [lat, lon] points of the route
 * @param {Array} stamps - Array of stamps included in the route
 */
export function displayExtendedRoute(geometry, stamps) {
    if (!map || !extendedRouteLayer || !Array.isArray(geometry)) return;

    // Clear previous extended route
    extendedRouteLayer.clearLayers();

    const points = geometry;
    if (!points.length) return;

    // Draw the extended route as a distinct color
    const routeLine = L.polyline(points, {
        color: '#8B5CF6',  // Purple - distinct from original route
        weight: 5,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round'
    });

    routeLine.bindPopup(`
        <strong>Erweiterte Route</strong>
        <div style="margin-top:4px;">Route mit ${stamps.length} Stempelstelle${stamps.length > 1 ? 'n' : ''}</div>
    `);

    extendedRouteLayer.addLayer(routeLine);

    // Add numbered markers for each stamp stop
    stamps.forEach((stamp, i) => {
        const marker = L.marker([stamp.lat, stamp.lon], {
            icon: L.divIcon({
                className: 'stop-marker',
                html: `<div class="stop-marker-inner">${i + 1}</div>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            }),
            zIndexOffset: 2000
        });

        marker.bindPopup(`
            <strong>${i + 1}. ${stamp.name}</strong>
            <div style="margin-top:4px;">${stamp.id}</div>
        `);

        extendedRouteLayer.addLayer(marker);
    });

    // Fit map to show the extended route
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
}

/**
 * Clear only the extended route layer
 */
export function clearExtendedRoute() {
    if (extendedRouteLayer) extendedRouteLayer.clearLayers();
}
