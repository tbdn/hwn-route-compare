import { parseGPX } from "./utils/gpx.js";
import { findNearbyStamps } from "./utils/geo.js";
import { loadStamps } from "./utils/stamps.js";

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

    if (!results.length) {
        grid.innerHTML = '<div class="empty">Keine Stempelstelle im gewählten Radius gefunden. Radius vergrößern oder Route prüfen.</div>';
        return;
    }

    results.forEach((stamp, i) => {
        const rotation = ((i * 37) % 11) - 5;
        const distClass = stamp.distance < 100 ? 'close' : (stamp.distance < 300 ? 'mid' : 'far');

        const card = document.createElement('div');
        card.className = 'stamp';
        card.style.setProperty('--rot', rotation + 'deg');

        const showDesc = stamp.description && stamp.description !== stamp.name;

        card.innerHTML = `
            <div class="badge">${stamp.id || '#'}</div>
            <h3>${escapeHtml(stamp.name)}</h3>
            <span class="dist ${distClass}">${Math.round(stamp.distance)} m entfernt</span>
            ${showDesc ? `<div class="desc">${escapeHtml(stamp.description)}</div>` : ''}
            <a href="https://www.google.com/maps?q=${stamp.lat},${stamp.lon}" target="_blank" rel="noopener">Auf Karte öffnen →</a>
        `;
        grid.appendChild(card);
    });
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
        const results = findNearbyStamps(sampledRoute, stamps, threshold);

        setStatus('Fertig.');
        stats.innerHTML = `<span><b>${routePoints.length}</b> Routenpunkte</span><span><b>${stamps.length}</b> bekannte Stempelstellen</span>`;
        render(results, routePoints.length, threshold);

    } catch (e) {
        setStatus(e.message || 'Unbekannter Fehler beim Verarbeiten.', true);
    } finally {
        goBtn.disabled = false;
    }
});
