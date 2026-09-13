import { parseGPX } from "./utils/gpx.js";
import { findNearbyStamps } from "./utils/geo.js";
import { loadStamps } from "./utils/stamps.js";
import { analyzeDetours, getDetourEffort } from "./utils/detour.js";
import { initMap, clearMap, displayRoute, displayAllStamps, displayMatchedStamps, displayDetourLines, displayRoutingResult, panToStamp } from "./components/map.js";
import { setApiKey, hasApiKey, calculateDetourRoute, formatDuration, formatDistance } from "./utils/routing.js";
import { optimizeStampOrder, calculateTotalDetour, generateGPX, downloadGPX } from "./utils/optimize.js";

const el = id => document.getElementById(id);

// UI element references
const threshInput = el('thresh');
const threshVal = el('threshVal');
const gpxInput = el('gpxInput');
const fileInput = el('fileInput');
const fileName = el('fileName');
const goBtn = el('goBtn');
const status = el('status');
const stats = el('stats');
const resultsSection = el('resultsSection');
const resultCount = el('resultCount');
const grid = el('grid');
const apiKeyInput = el('apiKeyInput');
const saveApiKeyBtn = el('saveApiKey');
const apiStatus = el('apiStatus');

// Selection bar elements
const selectionBar = el('selectionBar');
const selectionCount = el('selectionCount');
const clearSelectionBtn = el('clearSelection');
const optimizeRouteBtn = el('optimizeRoute');

// Modal elements
const modal = el('optimizedRouteModal');
const closeModalBtn = el('closeModal');
const routeComparison = el('routeComparison');
const optimizedStops = el('optimizedStops');
const exportGpxBtn = el('exportGpx');

// Map state
let mapInitialized = false;

// Store current results for routing
let currentResults = [];

// Store selected stamps for route optimization
let selectedStamps = new Set();

// Store optimized route for export
let optimizedRoute = null;

// API key persistence
const API_KEY_STORAGE = 'hwn-ors-api-key';

function loadSavedApiKey() {
    try {
        const saved = localStorage.getItem(API_KEY_STORAGE);
        if (saved) {
            setApiKey(saved);
            apiKeyInput.value = saved;
            updateApiStatus(true);
        }
    } catch {
        // ignore
    }
}

function updateApiStatus(hasKey) {
    if (hasKey) {
        apiStatus.textContent = '✓ API-Schlüssel gespeichert';
        apiStatus.className = 'api-status success';
    } else {
        apiStatus.textContent = '';
        apiStatus.className = 'api-status';
    }
}

// Save API key handler
saveApiKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (key) {
        setApiKey(key);
        try {
            localStorage.setItem(API_KEY_STORAGE, key);
        } catch {
            // ignore
        }
        updateApiStatus(true);
    } else {
        setApiKey(null);
        localStorage.removeItem(API_KEY_STORAGE);
        updateApiStatus(false);
    }
});

// Load saved API key on page load
loadSavedApiKey();

// Selection bar functions
function updateSelectionBar() {
    const count = selectedStamps.size;

    if (count === 0) {
        selectionBar.style.display = 'none';
        return;
    }

    selectionBar.style.display = 'flex';
    selectionCount.textContent = count === 1
        ? '1 Stempel ausgewählt'
        : `${count} Stempel ausgewählt`;

    // Enable optimize button only if we have at least 2 stamps
    optimizeRouteBtn.disabled = count < 2;
}

function clearSelection() {
    selectedStamps.clear();

    // Uncheck all checkboxes and remove selected class
    document.querySelectorAll('.stamp-checkbox').forEach(cb => {
        cb.checked = false;
    });
    document.querySelectorAll('.stamp.selected').forEach(card => {
        card.classList.remove('selected');
    });

    updateSelectionBar();
}

function getSelectedStamps() {
    return currentResults.filter(stamp => selectedStamps.has(stamp.id));
}

// Selection bar event handlers
clearSelectionBtn.addEventListener('click', clearSelection);

optimizeRouteBtn.addEventListener('click', () => {
    const selected = getSelectedStamps();
    if (selected.length < 2) return;

    // Optimize the route
    optimizedRoute = optimizeStampOrder(selected);

    // Calculate distances
    const originalDetour = calculateTotalDetour(selected);
    const optimizedDetour = calculateTotalDetour(optimizedRoute);

    // Show modal with results
    showOptimizedRouteModal(optimizedRoute, originalDetour, optimizedDetour);
});

function showOptimizedRouteModal(stamps, originalDetour, optimizedDetour) {
    // Format distances
    const formatDist = (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;

    // Show comparison
    routeComparison.innerHTML = `
        <div class="route-stat">
            <div class="label">Stempel</div>
            <div class="value">${stamps.length}</div>
        </div>
        <div class="route-stat">
            <div class="label">Geschätzter Umweg</div>
            <div class="value highlight">${formatDist(optimizedDetour)}</div>
        </div>
    `;

    // Show optimized order
    optimizedStops.innerHTML = `
        <h3>Optimierte Reihenfolge</h3>
        <div class="stop-list">
            ${stamps.map((stamp, i) => `
                <div class="stop-item">
                    <span class="stop-number">${i + 1}</span>
                    <span class="stop-name">${stamp.name}</span>
                    <span class="stop-id">${stamp.id}</span>
                </div>
            `).join('')}
        </div>
    `;

    modal.style.display = 'flex';
}

function closeModal() {
    modal.style.display = 'none';
}

// Modal event handlers
closeModalBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
});

// GPX export handler
exportGpxBtn.addEventListener('click', () => {
    if (!optimizedRoute || optimizedRoute.length === 0) return;

    const gpxContent = generateGPX(optimizedRoute, {
        name: 'HWN Stempelroute',
        description: `Optimierte Route mit ${optimizedRoute.length} Stempelstellen`
    });

    downloadGPX(gpxContent, 'hwn-stempelroute');
});

// Threshold slider update
threshInput.addEventListener('input', () => {
    threshVal.textContent = threshInput.value + ' m';
});

// File upload handler
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    fileName.textContent = file.name;
    const reader = new FileReader();
    reader.onload = () => {
        gpxInput.value = reader.result;
    };
    reader.readAsText(file);
});

// Downsample large routes for performance
function decimate(points, maxCount) {
    if (points.length <= maxCount) return points;
    const step = Math.ceil(points.length / maxCount);
    return points.filter((_, i) => i % step === 0);
}

function setStatus(msg, isError = false) {
    status.textContent = msg;
    status.classList.toggle('error', isError);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function render(results, routeLen, threshold) {
    resultsSection.style.display = results.length || routeLen ? 'block' : 'none';
    resultCount.textContent = results.length + ' Treffer · Radius ' + threshold + ' m';
    grid.innerHTML = '';

    // Store results for routing
    currentResults = results;

    // Clear selection when new results
    selectedStamps.clear();
    updateSelectionBar();

    if (!results.length) {
        grid.innerHTML = '<div class="empty">Keine Stempelstelle im gewählten Radius gefunden. Radius vergrößern oder Route prüfen.</div>';
        return;
    }

    results.forEach((stamp, i) => {
        const rotation = ((i * 37) % 11) - 5;

        // Color-code by detour effort instead of just distance
        const effort = getDetourEffort(stamp.detourDistance || stamp.distance * 2);
        const effortClass = effort === 'easy' ? 'close' : (effort === 'moderate' ? 'mid' : 'far');

        const card = document.createElement('div');
        card.className = 'stamp';
        card.style.setProperty('--rot', rotation + 'deg');
        card.dataset.stampId = stamp.id;

        const showDesc = stamp.description && stamp.description !== stamp.name;

        // Format detour distance
        const detourMeters = Math.round(stamp.detourDistance || stamp.distance * 2);
        const detourText = detourMeters < 1000
            ? `+${detourMeters} m`
            : `+${(detourMeters / 1000).toFixed(1)} km`;

        // Position along route (percentage)
        const positionPct = stamp.routePosition !== undefined
            ? Math.round(stamp.routePosition * 100)
            : null;

        // Check if we already have routing data (from cache)
        const hasRoutingData = stamp.routedDistance !== undefined;
        const routingHtml = hasRoutingData
            ? createRoutingResultHtml(stamp)
            : (hasApiKey() && stamp.exitPoint
                ? `<button class="calc-route-btn" data-stamp-id="${stamp.id}" title="Echte Wanderweg-Distanz berechnen">🥾 Route berechnen</button>`
                : '');

        card.innerHTML = `
            <label class="stamp-select">
                <input type="checkbox" class="stamp-checkbox" data-stamp-id="${stamp.id}">
                <span class="checkmark"></span>
            </label>
            <div class="badge">${stamp.id || '#'}</div>
            <h3>${escapeHtml(stamp.name)}</h3>
            <div class="stamp-meta">
                <span class="dist ${effortClass}">${Math.round(stamp.distance)} m entfernt</span>
                <span class="detour ${effortClass}" title="Geschätzter Umweg (hin und zurück)">${detourText} Umweg</span>
            </div>
            ${positionPct !== null ? `<div class="route-pos">Bei ${positionPct}% der Route</div>` : ''}
            <div class="routing-result" id="routing-${stamp.id}">${routingHtml}</div>
            ${showDesc ? `<div class="desc">${escapeHtml(stamp.description)}</div>` : ''}
            <div class="card-actions">
                <button class="show-on-map" title="Auf Karte zeigen">📍 Karte</button>
                <a href="https://www.google.com/maps?q=${stamp.lat},${stamp.lon}" target="_blank" rel="noopener">Google Maps →</a>
            </div>
        `;

        // Click handler for checkbox
        const checkbox = card.querySelector('.stamp-checkbox');
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) {
                selectedStamps.add(stamp.id);
                card.classList.add('selected');
            } else {
                selectedStamps.delete(stamp.id);
                card.classList.remove('selected');
            }
            updateSelectionBar();
        });

        // Click handler for "show on map" button
        const mapBtn = card.querySelector('.show-on-map');
        mapBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panToStamp(stamp);
        });

        // Click handler for "calculate route" button
        const routeBtn = card.querySelector('.calc-route-btn');
        if (routeBtn) {
            routeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                calculateRouteForStamp(stamp, routeBtn);
            });
        }

        grid.appendChild(card);
    });
}

function createRoutingResultHtml(stamp) {
    if (stamp.routingError) {
        return `<div class="routing-error">${stamp.routingError}</div>`;
    }
    if (stamp.routedDistance !== undefined) {
        const distText = formatDistance(stamp.routedDistance);
        const timeText = formatDuration(stamp.routedDuration);
        const elevText = stamp.routedAscent ? ` · ↑${stamp.routedAscent}m` : '';
        return `
            <div class="routing-success">
                <span class="routed-dist">🥾 ${distText}</span>
                <span class="routed-time">⏱ ${timeText}${elevText}</span>
            </div>
        `;
    }
    return '';
}

async function calculateRouteForStamp(stamp, button) {
    if (!stamp.exitPoint) return;

    // Update button state
    button.disabled = true;
    button.textContent = '⏳ Berechne...';

    const result = await calculateDetourRoute(stamp.exitPoint, stamp);
    const routingDiv = document.getElementById(`routing-${stamp.id}`);

    if (result.error) {
        stamp.routingError = result.error;
        routingDiv.innerHTML = `<div class="routing-error">${result.error}</div>`;
        button.textContent = '🥾 Route berechnen';
        button.disabled = false;
    } else {
        // Store result on stamp object
        stamp.routedDistance = result.distance;
        stamp.routedDuration = result.duration;
        stamp.routedAscent = result.ascent;
        stamp.routedGeometry = result.geometry;

        routingDiv.innerHTML = createRoutingResultHtml(stamp);

        // Display route on map
        if (result.geometry) {
            displayRoutingResult(stamp, result.geometry);
        }
    }
}

// Cached stamps
let stampsCache = null;

async function getStamps() {
    if (stampsCache) return stampsCache;

    setStatus('Lade Stempeldaten …');
    stampsCache = await loadStamps();
    return stampsCache;
}

// Main comparison handler
goBtn.addEventListener('click', async () => {
    const gpxText = gpxInput.value.trim();
    stats.innerHTML = '';

    if (!gpxText) {
        setStatus('Bitte zuerst GPX-Daten einfügen oder eine .gpx-Datei hochladen.', true);
        return;
    }

    goBtn.disabled = true;

    try {
        setStatus('Lese Route …');
        const routePoints = parseGPX(gpxText);

        if (!routePoints.length) {
            setStatus('In den GPX-Daten wurden keine Track-/Routenpunkte gefunden.', true);
            return;
        }

        const stamps = await getStamps();

        if (!stamps.length) {
            setStatus('Stempeldaten konnten nicht geladen werden.', true);
            return;
        }

        setStatus('Vergleiche ' + routePoints.length + ' Routenpunkte mit ' + stamps.length + ' Stempelstellen …');

        // Let status paint before heavy computation
        await new Promise(r => setTimeout(r, 10));

        const threshold = parseInt(threshInput.value, 10);
        const sampledRoute = decimate(routePoints, 3000);

        // Find nearby stamps
        const nearbyStamps = findNearbyStamps(sampledRoute, stamps, threshold);

        // Analyze detours (find exit points, calculate detour distances)
        setStatus('Analysiere Umwege …');
        await new Promise(r => setTimeout(r, 10));

        const results = analyzeDetours(nearbyStamps, routePoints);

        setStatus('Fertig.');
        stats.innerHTML = `<span><b>${routePoints.length}</b> Routenpunkte</span><span><b>${stamps.length}</b> bekannte Stempelstellen</span>`;

        // Render results (now sorted by position along route)
        render(results, routePoints.length, threshold);

        // Initialize map if needed (after results section is visible)
        if (!mapInitialized) {
            await new Promise(r => setTimeout(r, 50)); // Wait for DOM update
            initMap();
            mapInitialized = true;
        }

        // Update map
        clearMap();
        displayRoute(routePoints);
        displayAllStamps(stamps);
        displayMatchedStamps(results);
        displayDetourLines(results);

    } catch (e) {
        setStatus(e.message || 'Unbekannter Fehler beim Verarbeiten.', true);
    } finally {
        goBtn.disabled = false;
    }
});
