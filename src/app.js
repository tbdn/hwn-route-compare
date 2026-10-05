import { parseGPX } from "./utils/gpx.js";
import { findNearbyStamps } from "./utils/geo.js";
import { loadStamps } from "./utils/stamps.js";
import { analyzeDetours, getDetourEffort } from "./utils/detour.js";
import { initMap, clearMap, displayRoute, displayAllStamps, displayMatchedStamps, displayDetourLines, displayRoutingResult, displayExtendedRoute, clearExtendedRoute, panToStamp, getMap } from "./components/map.js";
import { showTourPlan } from "./components/tourplan.js";
import { setApiKey, hasApiKey, calculateDetourRoute, calculateMultiWaypointRoute, formatDuration, formatDistance } from "./utils/routing.js";
import { optimizeStampOrder, calculateTotalDetour, generateGPX, downloadGPX } from "./utils/optimize.js";

const el = id => document.getElementById(id);

// UI element references
const threshInput = el('thresh');
const threshVal = el('threshVal');
const fileInput = el('fileInput');
const fileNameEl = el('fileName');
const goBtn = el('goBtn');

// Store loaded GPX content
let gpxContent = null;
const status = el('status');
const stats = el('stats');
const resultsSection = el('resultsSection');
const resultCount = el('resultCount');
const onRouteSection = el('onRouteSection');
const onRouteGrid = el('onRouteGrid');
const nearbySection = el('nearbySection');
const nearbyGrid = el('nearbyGrid');

// Threshold for "on route" classification (meters)
const ON_ROUTE_THRESHOLD = 25;
const apiKeyInput = el('apiKeyInput');
const saveApiKeyBtn = el('saveApiKey');
const apiStatus = el('apiStatus');

// Selection bar elements
const selectionBar = el('selectionBar');
const selectionCount = el('selectionCount');
const clearSelectionBtn = el('clearSelection');
const addToRouteBtn = el('addToRoute');

// Modal elements
const modal = el('optimizedRouteModal');
const closeModalBtn = el('closeModal');
const routeComparison = el('routeComparison');
const optimizedStops = el('optimizedStops');
const routeStatusEl = el('routeStatus');
const showOnMapBtn = el('showOnMap');
const exportGpxBtn = el('exportGpx');

// Map state
let mapInitialized = false;

// Store current results for routing
let currentResults = [];

// Store selected stamps for route optimization
let selectedStamps = new Set();

// Store optimized route for export
let optimizedRoute = null;

// Store calculated route geometry
let calculatedRouteGeometry = null;

// Store original route points for route calculation
let currentRoutePoints = [];

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

    // Enable button if we have at least 1 stamp AND API key is set
    addToRouteBtn.disabled = count < 1 || !hasApiKey();

    // Update button text if no API key
    if (!hasApiKey()) {
        addToRouteBtn.textContent = 'API-Schlüssel fehlt';
    } else {
        addToRouteBtn.textContent = 'Zur Route hinzufügen';
    }
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

    // Clear extended route from map
    clearExtendedRoute();

    updateSelectionBar();
}

function getSelectedStamps() {
    return currentResults.filter(stamp => selectedStamps.has(stamp.id));
}

// Selection bar event handlers
clearSelectionBtn.addEventListener('click', clearSelection);

addToRouteBtn.addEventListener('click', async () => {
    const selected = getSelectedStamps();
    if (selected.length < 1 || !hasApiKey()) return;

    // Sort stamps by position along route
    const sortedStamps = [...selected].sort((a, b) => a.routePosition - b.routePosition);
    optimizedRoute = sortedStamps;

    // Show modal immediately with loading state
    showExtendedRouteModal(sortedStamps, true);

    // Build waypoints: start point -> stamps (via exit points) -> end point
    const startPoint = currentRoutePoints[0];
    const endPoint = currentRoutePoints[currentRoutePoints.length - 1];

    const waypoints = [
        startPoint,
        ...sortedStamps.map(s => ({ lat: s.lat, lon: s.lon })),
        endPoint
    ];

    // Calculate actual route through stamps
    const result = await calculateMultiWaypointRoute(waypoints);

    if (result.error) {
        updateRouteStatus(result.error, 'error');
        showOnMapBtn.disabled = true;
    } else {
        calculatedRouteGeometry = result.geometry;

        // Update modal with actual distances
        updateModalWithRouteData(sortedStamps, result);
        updateRouteStatus('Route berechnet', 'success');
        showOnMapBtn.disabled = false;
    }
});

function showExtendedRouteModal(stamps, loading = false) {
    // Format for display
    const formatDist = (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
    const estimatedDetour = calculateTotalDetour(stamps);

    // Show comparison (estimated values initially)
    routeComparison.innerHTML = `
        <div class="route-stat">
            <div class="label">Stempel</div>
            <div class="value">${stamps.length}</div>
        </div>
        <div class="route-stat">
            <div class="label">Gesamtstrecke</div>
            <div class="value" id="totalDistance">${loading ? '...' : '-'}</div>
        </div>
    `;

    // Show order
    optimizedStops.innerHTML = `
        <h3>Reihenfolge entlang der Route</h3>
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

    // Show loading state
    if (loading) {
        updateRouteStatus('Berechne Route...', 'loading');
        showOnMapBtn.disabled = true;
    } else {
        routeStatusEl.innerHTML = '';
        routeStatusEl.className = 'route-status';
    }

    modal.style.display = 'flex';
}

function updateModalWithRouteData(stamps, routeData) {
    const formatDist = (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
    const formatTime = (s) => {
        const mins = Math.round(s / 60);
        if (mins < 60) return `${mins} min`;
        const hours = Math.floor(mins / 60);
        const remainingMins = mins % 60;
        return remainingMins > 0 ? `${hours}h ${remainingMins}min` : `${hours}h`;
    };

    routeComparison.innerHTML = `
        <div class="route-stat">
            <div class="label">Stempel</div>
            <div class="value">${stamps.length}</div>
        </div>
        <div class="route-stat">
            <div class="label">Gesamtstrecke</div>
            <div class="value highlight">${formatDist(routeData.distance)}</div>
        </div>
        <div class="route-stat">
            <div class="label">Gehzeit</div>
            <div class="value">${formatTime(routeData.duration)}</div>
        </div>
        <div class="route-stat">
            <div class="label">Höhenmeter</div>
            <div class="value">↑${routeData.ascent}m ↓${routeData.descent}m</div>
        </div>
    `;
}

function updateRouteStatus(message, type) {
    routeStatusEl.textContent = message;
    routeStatusEl.className = `route-status ${type}`;
}

function closeModal() {
    modal.style.display = 'none';
}

// Modal event handlers
closeModalBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
});

// Show on map handler
showOnMapBtn.addEventListener('click', () => {
    if (!calculatedRouteGeometry || !optimizedRoute) return;

    displayExtendedRoute(calculatedRouteGeometry, optimizedRoute);
    closeModal();
});

// GPX export handler
exportGpxBtn.addEventListener('click', () => {
    if (!optimizedRoute || optimizedRoute.length === 0) return;

    const gpxContent = generateGPX(optimizedRoute, {
        name: 'HWN Stempelroute',
        description: `Route mit ${optimizedRoute.length} Stempelstellen`
    });

    downloadGPX(gpxContent, 'hwn-stempelroute');
});

// Threshold slider update
threshInput.addEventListener('input', () => {
    const val = parseInt(threshInput.value, 10);
    threshVal.textContent = val >= 1000 ? (val / 1000) + ' km' : val + ' m';
});

// File upload handler
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) {
        gpxContent = null;
        fileNameEl.textContent = 'Keine Datei ausgewählt';
        fileNameEl.classList.remove('has-file');
        goBtn.disabled = true;
        return;
    }

    fileNameEl.textContent = file.name;
    fileNameEl.classList.add('has-file');

    const reader = new FileReader();
    reader.onload = () => {
        gpxContent = reader.result;
        goBtn.disabled = false;
    };
    reader.onerror = () => {
        setStatus('Fehler beim Lesen der Datei.', true);
        gpxContent = null;
        goBtn.disabled = true;
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

    // Format threshold for display
    const thresholdText = threshold >= 1000 ? (threshold / 1000) + ' km' : threshold + ' m';
    resultCount.textContent = results.length + ' Treffer · Radius ' + thresholdText;

    // Clear grids
    onRouteGrid.innerHTML = '';
    nearbyGrid.innerHTML = '';

    // Store results for routing
    currentResults = results;

    // Clear selection when new results
    selectedStamps.clear();
    updateSelectionBar();

    if (!results.length) {
        onRouteSection.style.display = 'none';
        nearbySection.style.display = 'block';
        nearbyGrid.innerHTML = '<div class="empty">Keine Stempelstelle im gewählten Radius gefunden. Radius vergrößern oder Route prüfen.</div>';
        return;
    }

    // Split results into "on route" and "nearby"
    const onRoute = results.filter(s => s.distance <= ON_ROUTE_THRESHOLD);
    const nearby = results.filter(s => s.distance > ON_ROUTE_THRESHOLD);

    // Render "on route" section
    onRouteSection.style.display = onRoute.length > 0 ? 'block' : 'none';
    onRoute.forEach((stamp, i) => {
        const card = createStampCard(stamp, i, true);
        onRouteGrid.appendChild(card);
    });

    // Render "nearby" section
    nearbySection.style.display = nearby.length > 0 ? 'block' : 'none';
    nearby.forEach((stamp, i) => {
        const card = createStampCard(stamp, i, false);
        nearbyGrid.appendChild(card);
    });
}

function createStampCard(stamp, index, isOnRoute) {
    const rotation = ((index * 37) % 11) - 5;

    // Color-code by detour effort
    const effort = getDetourEffort(stamp.detourDistance || stamp.distance * 2);
    const effortClass = effort === 'easy' ? 'close' : (effort === 'moderate' ? 'mid' : 'far');

    const card = document.createElement('div');
    card.className = 'stamp';
    card.style.setProperty('--rot', rotation + 'deg');
    card.dataset.stampId = stamp.id;

    const showDesc = stamp.description && stamp.description !== stamp.name;

    // Format distance
    const distText = stamp.distance < 1000
        ? `${Math.round(stamp.distance)} m`
        : `${(stamp.distance / 1000).toFixed(1)} km`;

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
        : (hasApiKey() && stamp.exitPoint && !isOnRoute
            ? `<button class="calc-route-btn" data-stamp-id="${stamp.id}" title="Echte Wanderweg-Distanz berechnen">🥾 Route berechnen</button>`
            : '');

    // For on-route stamps, show simpler info
    const metaHtml = isOnRoute
        ? `<div class="stamp-meta"><span class="dist close">${distText} von Route</span></div>`
        : `<div class="stamp-meta">
            <span class="dist ${effortClass}">${distText} entfernt</span>
            <span class="detour ${effortClass}" title="Geschätzter Umweg (hin und zurück)">${detourText} Umweg</span>
           </div>`;

    card.innerHTML = `
        <label class="stamp-select">
            <input type="checkbox" class="stamp-checkbox" data-stamp-id="${stamp.id}">
            <span class="checkmark"></span>
        </label>
        <div class="badge">${stamp.id || '#'}</div>
        <h3>${escapeHtml(stamp.name)}</h3>
        ${metaHtml}
        ${positionPct !== null ? `<div class="route-pos">Bei ${positionPct}% der Route</div>` : ''}
        <div class="coords">${stamp.lat.toFixed(5)}, ${stamp.lon.toFixed(5)}</div>
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

    return card;
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

async function getStamps(silent = false) {
    if (stampsCache) return stampsCache;

    if (!silent) setStatus('Lade Stempeldaten …');
    stampsCache = await loadStamps();
    return stampsCache;
}

// View switching (Routenabgleich / Tourenplan)
const VIEW_HASH = { compare: '', tours: '#touren' };
const tabs = document.querySelectorAll('.tab');

async function switchView(view) {
    tabs.forEach(tab => {
        const active = tab.dataset.view === view;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
    });
    el('viewCompare').hidden = view !== 'compare';
    el('viewTours').hidden = view !== 'tours';
    document.querySelectorAll('[data-view-header]').forEach(h => {
        h.hidden = h.dataset.viewHeader !== view;
    });

    if (view === 'compare') {
        getMap()?.invalidateSize();
        return;
    }
    try {
        await showTourPlan(await getStamps(true));
    } catch (e) {
        el('tourStatus').textContent = e.message || 'Tourenplan konnte nicht geladen werden.';
    }
}

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const view = tab.dataset.view;
        history.replaceState(null, '', VIEW_HASH[view] || location.pathname + location.search);
        switchView(view);
    });
    tab.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const other = [...tabs].find(t => t !== tab);
        other.focus();
        other.click();
    });
});

window.addEventListener('hashchange', () => switchView(location.hash === VIEW_HASH.tours ? 'tours' : 'compare'));
if (location.hash === VIEW_HASH.tours) switchView('tours');

// Main comparison handler
goBtn.addEventListener('click', async () => {
    stats.innerHTML = '';

    if (!gpxContent) {
        setStatus('Bitte zuerst eine GPX-Datei auswählen.', true);
        return;
    }

    const gpxText = gpxContent;

    goBtn.disabled = true;

    try {
        setStatus('Lese Route …');
        const routePoints = parseGPX(gpxText);

        if (!routePoints.length) {
            setStatus('In den GPX-Daten wurden keine Track-/Routenpunkte gefunden.', true);
            return;
        }

        // Store route points for extended route calculation
        currentRoutePoints = routePoints;

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
