// Map component using Leaflet
// Centered on the Harz region by default

const HARZ_CENTER = [51.75, 10.65];
const DEFAULT_ZOOM = 10;

let map = null;
let routeLayer = null;
let stampsLayer = null;
let matchedLayer = null;

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

    // Initialize layer groups
    routeLayer = L.layerGroup().addTo(map);
    stampsLayer = L.layerGroup().addTo(map);
    matchedLayer = L.layerGroup().addTo(map);

    return map;
}

export function clearMap() {
    if (routeLayer) routeLayer.clearLayers();
    if (stampsLayer) stampsLayer.clearLayers();
    if (matchedLayer) matchedLayer.clearLayers();
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
    }

    return html;
}

export function getMap() {
    return map;
}
