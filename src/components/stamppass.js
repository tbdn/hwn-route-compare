// "Meine Stempel": all 222 stamps at a glance, collected ones highlighted.
// Stamps are toggled here or entered as a list of numbers (e.g. from the paper stamp booklet).
// Progress itself lives in tourplan.js (`hwn-stamps-collected`), so both views always show the same state.

import { loadStampProgress, isStampCollected, suggestionOfStamp, setStampsCollected } from "./tourplan.js";

const el = id => document.getElementById(id);

let initialized = false;
let allStamps = [];
let filter = 'all';               // all | open | got
let undo = null;                  // stamp numbers added by the last list entry

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Show the stamp page. Loads the progress and builds the grid on first call.
 * @param {Array} stamps - All stamps in internal format
 */
export async function showStampPass(stamps) {
    if (!initialized) {
        await loadStampProgress(stamps);
        allStamps = [...stamps].sort((a, b) => a.number - b.number);
        initialized = true;
        buildGrid();
        bindControls();
        document.addEventListener('hwn:progress-changed', sync);
    }
    sync();
}

function buildGrid() {
    el('passGrid').innerHTML = allStamps.map(s => {
        const tour = suggestionOfStamp(s.number);
        const title = s.description && s.description !== s.name ? ` title="${escapeHtml(s.description)}"` : '';
        return `
            <div class="pass-stamp" data-stamp="${s.number}" style="--c:${tour?.color || 'var(--ink)'}">
                <label class="pass-check"${title}>
                    <input type="checkbox" class="pass-done" data-stamp="${s.number}" aria-label="${escapeHtml(`${s.id} ${s.name} gestempelt`)}">
                    <span class="pass-number">${s.number}</span>
                    <span class="pass-name">${escapeHtml(s.name)}</span>
                </label>
                <span class="pass-meta">
                    ${s.elevation ? `<span>${s.elevation} m</span>` : ''}
                    ${tour ? `<button type="button" class="pass-tour" data-tour="${tour.id}" title="Vorschlag ${tour.id} (${escapeHtml(tour.regionName)}) im Tourenplan zeigen">${tour.id}</button>` : ''}
                </span>
            </div>`;
    }).join('');

    el('passGrid').querySelectorAll('.pass-done').forEach(cb =>
        cb.addEventListener('change', () => setStampsCollected([Number(cb.dataset.stamp)], cb.checked)));
    el('passGrid').querySelectorAll('.pass-tour').forEach(b =>
        b.addEventListener('click', () => document.dispatchEvent(new CustomEvent('hwn:show-tour', { detail: { id: b.dataset.tour } }))));
}

function bindControls() {
    el('passSearch').addEventListener('input', applyFilter);
    el('passFilter').querySelectorAll('[data-filter]').forEach(b =>
        b.addEventListener('click', () => {
            filter = b.dataset.filter;
            applyFilter();
        }));

    el('passBulk').addEventListener('submit', e => {
        e.preventDefault();
        const { numbers, invalid } = parseNumbers(el('passBulkInput').value);
        if (!numbers.length) {
            setBulkStatus(invalid.length ? `Keine gültigen Nummern (1–${allStamps.length}): ${invalid.join(', ')}` : 'Bitte Stempelnummern eingeben.', true);
            return;
        }
        const added = numbers.filter(n => !isStampCollected(n));
        undo = added.length ? added : null;
        setStampsCollected(added, true);
        el('passBulkInput').value = '';
        const already = numbers.length - added.length;
        let msg = `${added.length} Stempel eingetragen`;
        if (already) msg += `, ${already} ${already === 1 ? 'war' : 'waren'} schon gestempelt`;
        msg += '.';
        if (invalid.length) msg += ` Ignoriert: ${invalid.join(', ')}`;
        setBulkStatus(msg, false);
    });
    el('passUndo').addEventListener('click', () => {
        if (!undo) return;
        const n = undo.length;
        setStampsCollected(undo, false);
        undo = null;
        setBulkStatus(`${n} Stempel wieder entfernt.`, false);
    });
}

/**
 * Parse "3, 17 120-125" into stamp numbers; unknown tokens are returned as invalid
 * @param {string} input
 * @returns {{numbers: Array<number>, invalid: Array<string>}}
 */
export function parseNumbers(input) {
    const known = new Set(allStamps.map(s => s.number));
    const numbers = new Set();
    const invalid = [];
    input.split(/[\s,;]+/).filter(Boolean).forEach(token => {
        const range = token.match(/^(?:HWN)?0*(\d+)(?:[-–](?:HWN)?0*(\d+))?$/i);
        if (!range) {
            invalid.push(token);
            return;
        }
        const from = Number(range[1]);
        const to = range[2] ? Number(range[2]) : from;
        if (to < from || !known.has(from) || !known.has(to)) {
            invalid.push(token);
            return;
        }
        for (let n = from; n <= to; n++) numbers.add(n);
    });
    return { numbers: [...numbers], invalid };
}

function setBulkStatus(msg, isError) {
    const status = el('passBulkStatus');
    status.textContent = msg;
    status.classList.toggle('error', isError);
    el('passUndo').hidden = isError || !undo;
}

function matches(stamp, query) {
    if (!query) return true;
    if (/^\d+$/.test(query)) return stamp.number === Number(query);
    return [stamp.id, stamp.name, stamp.description].some(v => v?.toLowerCase().includes(query));
}

// Filter and search decide which tiles are shown. A stamp ticked under "Offen" stays visible until
// the filter changes, so a slip can be undone right away.
function applyFilter() {
    const query = el('passSearch').value.trim().toLowerCase();
    let shown = 0;
    el('passGrid').querySelectorAll('.pass-stamp').forEach(tile => {
        const stamp = allStamps.find(s => s.number === Number(tile.dataset.stamp));
        const got = isStampCollected(stamp.number);
        const visible = matches(stamp, query) && (filter === 'all' || (filter === 'got') === got);
        tile.hidden = !visible;
        if (visible) shown++;
    });
    el('passFilter').querySelectorAll('[data-filter]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
    el('passEmpty').hidden = shown > 0;
}

// Refresh states and counts in place, so focus stays on the ticked checkbox
function sync() {
    if (!initialized) return;
    let got = 0;
    el('passGrid').querySelectorAll('.pass-stamp').forEach(tile => {
        const on = isStampCollected(Number(tile.dataset.stamp));
        if (on) got++;
        tile.classList.toggle('got', on);
        const cb = tile.querySelector('.pass-done');
        cb.checked = on;
        cb.toggleAttribute('checked', on);
    });
    const total = allStamps.length;
    const percent = total ? Math.round(got / total * 100) : 0;
    el('passStats').innerHTML = `
        <div class="route-stat"><div class="label">Stempel gesammelt</div><div class="value highlight">${got} <small>/ ${total}</small></div></div>
        <div class="route-stat"><div class="label">Offene Stempel</div><div class="value">${total - got}</div></div>
        <div class="route-stat"><div class="label">Fortschritt</div><div class="value">${percent} %</div>
            <div class="pass-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${got}" aria-label="Gesammelte Stempel"><i style="width:${got / total * 100}%"></i></div></div>`;
    const counts = { all: total, open: total - got, got };
    el('passFilter').querySelectorAll('[data-filter]').forEach(b => {
        b.querySelector('.mono').textContent = counts[b.dataset.filter];
    });
    if (undo && undo.some(n => !isStampCollected(n))) {
        undo = null;
        el('passUndo').hidden = true;
    }
    applyFilter();
}
