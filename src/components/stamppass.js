// "Meine Stempel": all 222 stamps at a glance, collected ones highlighted.
// Stamps are toggled here or entered as a list of numbers (e.g. from the paper stamp booklet).
// Progress itself lives in tourplan.js (`hwn-stamps-collected`), so both views always show the same state.

import {
    loadStampProgress, isStampCollected, suggestionOfStamp, setStampsCollected, stampDate, setStampDate, today,
    stampPlanning, loadPlanTracks
} from "./tourplan.js";

const el = id => document.getElementById(id);

let initialized = false;
let allStamps = [];
let filter = 'all';               // all | open | planned | got
let planning = new Map();         // open stamp -> {status, unitId, name, origin, originLabel}
let sort = 'number';              // number | recent
let undo = null;                  // stamp numbers added by the last list entry

// 'YYYY-MM-DD' -> '05.10.26'
const shortDate = d => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)}`;
const longDate = d => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

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
        // Tracks decide what is "verplant"; they load in the background and sync when ready
        loadPlanTracks().catch(() => {});
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
                    ${s.elevation ? `<span class="pass-ele">${s.elevation} m</span>` : ''}
                    <button type="button" class="pass-date" data-stamp="${s.number}" hidden></button>
                    <input type="date" class="pass-date-input" data-stamp="${s.number}" hidden aria-label="${escapeHtml(`${s.id} ${s.name} gestempelt am`)}">
                    <button type="button" class="pass-plan" hidden></button>
                    ${tour ? `<button type="button" class="pass-tour" data-tour="${tour.id}" title="Vorschlag ${tour.id} (${escapeHtml(tour.regionName)}) im Tourenplan zeigen">${tour.id}</button>` : ''}
                </span>
            </div>`;
    }).join('');

    el('passGrid').querySelectorAll('.pass-done').forEach(cb =>
        cb.addEventListener('change', () => setStampsCollected([Number(cb.dataset.stamp)], cb.checked)));
    // The date of a collected stamp is edited in place; an empty field means "ohne Datum"
    el('passGrid').querySelectorAll('.pass-date').forEach(b => b.addEventListener('click', () => {
        const input = b.parentElement.querySelector('.pass-date-input');
        input.value = stampDate(Number(b.dataset.stamp)) || '';
        input.max = today();
        b.hidden = true;
        input.hidden = false;
        input.focus();
    }));
    el('passGrid').querySelectorAll('.pass-date-input').forEach(input => {
        input.addEventListener('change', () => setStampDate(Number(input.dataset.stamp), input.value || null));
        input.addEventListener('blur', () => {
            input.hidden = true;
            sync();
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === 'Escape') input.blur();
        });
    });
    el('passGrid').querySelectorAll('.pass-plan').forEach(b =>
        b.addEventListener('click', () => document.dispatchEvent(new CustomEvent('hwn:show-tour', { detail: { id: b.dataset.unit } }))));
    el('passGrid').querySelectorAll('.pass-tour').forEach(b =>
        b.addEventListener('click', () => document.dispatchEvent(new CustomEvent('hwn:show-tour', { detail: { id: b.dataset.tour } }))));
}

function bindControls() {
    el('passSearch').addEventListener('input', applyFilter);
    el('passBulkDate').value = today();
    el('passBulkDate').max = today();
    el('passSort').addEventListener('change', () => {
        sort = el('passSort').value;
        applySort();
    });
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
        const date = el('passBulkDate').value || today();
        undo = added.length ? added : null;
        setStampsCollected(added, true, date);
        el('passBulkInput').value = '';
        const already = numbers.length - added.length;
        let msg = `${added.length} Stempel eingetragen${added.length && date !== today() ? ` (am ${longDate(date)})` : ''}`;
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

// Newest date first, then collected stamps without a date, then open stamps; each group by number.
// Only re-sorted when the sort is chosen, so tiles don't jump while you tick them.
function applySort() {
    const rank = s => {
        const date = stampDate(s.number);
        return date ? 0 : isStampCollected(s.number) ? 1 : 2;
    };
    const ordered = sort === 'recent'
        ? [...allStamps].sort((a, b) => rank(a) - rank(b)
            || (stampDate(b.number) || '').localeCompare(stampDate(a.number) || '')
            || a.number - b.number)
        : allStamps;
    const grid = el('passGrid');
    ordered.forEach(s => grid.appendChild(grid.querySelector(`.pass-stamp[data-stamp="${s.number}"]`)));
}

// Filter and search decide which tiles are shown. A stamp ticked under "Offen" stays visible until
// the filter changes, so a slip can be undone right away.
function applyFilter() {
    const query = el('passSearch').value.trim().toLowerCase();
    let shown = 0;
    el('passGrid').querySelectorAll('.pass-stamp').forEach(tile => {
        const stamp = allStamps.find(s => s.number === Number(tile.dataset.stamp));
        const got = isStampCollected(stamp.number);
        const visible = matches(stamp, query) && (filter === 'all'
            || (filter === 'got' && got) || (filter === 'open' && !got)
            || (filter === 'planned' && planning.get(stamp.number)?.status === 'planned'));
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
    planning = stampPlanning();
    let got = 0;
    let dated = 0;
    let thisYear = 0;
    const year = today().slice(0, 4);
    el('passGrid').querySelectorAll('.pass-stamp').forEach(tile => {
        const on = isStampCollected(Number(tile.dataset.stamp));
        if (on) got++;
        tile.classList.toggle('got', on);
        const cb = tile.querySelector('.pass-done');
        cb.checked = on;
        cb.toggleAttribute('checked', on);
        // Collected stamps show their date instead of the elevation
        const date = on ? stampDate(Number(tile.dataset.stamp)) : null;
        const button = tile.querySelector('.pass-date');
        const editing = !tile.querySelector('.pass-date-input').hidden;
        button.hidden = !on || editing;
        button.textContent = date ? shortDate(date) : 'Datum?';
        button.classList.toggle('missing', !date);
        button.title = date ? `Gestempelt am ${longDate(date)}, ändern` : 'Ohne Datum, Datum eintragen';
        const ele = tile.querySelector('.pass-ele');
        if (ele) ele.hidden = on;
        // Planned with a Komoot or other checked track, or only in an own tour with an unchecked track
        const p = on ? null : planning.get(Number(tile.dataset.stamp));
        const plan = tile.querySelector('.pass-plan');
        const shownPlan = p && (p.status === 'planned' || p.status === 'own-unchecked') ? p : null;
        plan.hidden = !shownPlan;
        tile.classList.toggle('planned', shownPlan?.status === 'planned');
        if (shownPlan) {
            plan.dataset.unit = shownPlan.unitId;
            plan.textContent = shownPlan.status === 'planned' ? 'verplant' : 'eigene Tour';
            plan.classList.toggle('unchecked', shownPlan.status !== 'planned');
            plan.title = shownPlan.status === 'planned'
                ? `Verplant: ${shownPlan.name} · ${shownPlan.originLabel}`
                : `In ${shownPlan.name}, Track ungeprüft (${shownPlan.originLabel || 'ohne Track'})`;
        }
        if (date?.startsWith(year)) thisYear++;
        if (date) dated++;
    });
    const total = allStamps.length;
    const plannedCount = [...planning.values()].filter(p => p.status === 'planned').length;
    const percent = total ? Math.round(got / total * 100) : 0;
    el('passStats').innerHTML = `
        <div class="route-stat"><div class="label">Stempel gesammelt</div><div class="value highlight">${got} <small>/ ${total}</small></div></div>
        <div class="route-stat"><div class="label">Offene Stempel</div><div class="value">${total - got}</div></div>`
        + (plannedCount ? `<div class="route-stat" title="Offene Stempel mit Komoot-Track oder Track aus einem anderen Dienst"><div class="label">davon verplant</div><div class="value">${plannedCount}</div></div>` : '')
        + (dated ? `<div class="route-stat" title="Stempel mit Datum aus ${year}"><div class="label">Dieses Jahr</div><div class="value highlight">${thisYear}</div></div>` : '')
        + `
        <div class="route-stat"><div class="label">Fortschritt</div><div class="value">${percent} %</div>
            <div class="pass-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${got}" aria-label="Gesammelte Stempel"><i style="width:${got / total * 100}%"></i></div></div>`;
    const counts = { all: total, open: total - got, planned: plannedCount, got };
    el('passFilter').querySelectorAll('[data-filter]').forEach(b => {
        b.querySelector('.mono').textContent = counts[b.dataset.filter];
    });
    if (undo && undo.some(n => !isStampCollected(n))) {
        undo = null;
        el('passUndo').hidden = true;
    }
    applyFilter();
}
