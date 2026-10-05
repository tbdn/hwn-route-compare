// Date per stamp (plan "Stempel" step 3): set when collected, kept on a second tick, removed with the stamp,
// edited on the tile, entered with a list, sorted by, exported as v4 and imported from older files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupBrowser, startTourPlan, stamps, tourById, SRC, $, $$, tick, text, setChecked, importProgressFile, rowState
} from './helpers/browser.mjs';

// Stamp 5 was collected by an older app version (no date); 6 has a date, 999 and 7 are stale entries
const env = setupBrowser({ storage: {
    'hwn-stamps-collected': '[5,6]',
    'hwn-stamp-dates': '{"6":"2026-08-14","7":"2026-08-14","999":"2026-08-14","5":"kaputt"}'
} });
const pass = await import(SRC + 'components/stamppass.js');
const plan = await import(SRC + 'components/tourplan.js');
await pass.showStampPass(stamps);
const today = plan.today();
const dates = () => JSON.parse(env.store['hwn-stamp-dates']);
const tile = n => $(`.pass-stamp[data-stamp="${n}"]`);
const toggle = (n, on) => setChecked(tile(n).querySelector('.pass-done'), on);
const order = () => $$('.pass-stamp').map(t => Number(t.dataset.stamp));
// linkedom has no setter for select.value: choose the option like the browser would
function choose(select, value) {
    [...select.querySelectorAll('option')].forEach(o => o.toggleAttribute('selected', o.value === value));
    select.dispatchEvent(new Event('change'));
}
const passStats = () => Object.fromEntries($$('#passStats .route-stat').map(d => [d.querySelector('.label').textContent, text(d.querySelector('.value'))]));

test('loads only valid dates of collected stamps', () => {
    assert.equal(plan.stampDate(6), '2026-08-14');
    assert.equal(plan.stampDate(5), null);
    assert.equal(plan.stampDate(7), null);
    assert.equal(text(tile(6).querySelector('.pass-date')), '14.08.26');
    assert.equal(text(tile(5).querySelector('.pass-date')), 'Datum?');
    assert.equal(tile(1).querySelector('.pass-date').hidden, true, 'open stamps show no date');
});

test('a tick sets today, removing deletes, a stamp keeps its date', () => {
    toggle(1, true);
    assert.equal(dates()['1'], today);
    plan.setStampsCollected([6], true);
    assert.equal(dates()['6'], '2026-08-14', 'already collected: date kept');
    toggle(1, false);
    assert.equal(dates()['1'], undefined);
    assert.deepEqual(Object.keys(dates()), ['6']);
});

test('the date is edited on the tile and can be cleared', () => {
    tile(5).querySelector('.pass-date').click();
    const input = tile(5).querySelector('.pass-date-input');
    assert.equal(input.hidden, false);
    input.value = '2025-06-01';
    input.dispatchEvent(new Event('change'));
    input.dispatchEvent(new Event('blur'));
    assert.equal(dates()['5'], '2025-06-01');
    assert.equal(text(tile(5).querySelector('.pass-date')), '01.06.25');
    assert.equal(input.hidden, true);

    tile(5).querySelector('.pass-date').click();
    input.value = '';
    input.dispatchEvent(new Event('change'));
    input.dispatchEvent(new Event('blur'));
    assert.equal(dates()['5'], undefined);
    assert.ok(tile(5).classList.contains('got'), 'still collected');
});

test('a list is entered with the chosen date', () => {
    assert.equal($('#passBulkDate').value, today);
    $('#passBulkDate').value = '2026-09-20';
    $('#passBulkInput').value = '6, 10-11';
    $('#passBulk').dispatchEvent(new Event('submit'));
    assert.match($('#passBulkStatus').textContent, /^2 Stempel eingetragen \(am 20\.09\.2026\), 1 war schon gestempelt/);
    assert.equal(dates()['10'], '2026-09-20');
    assert.equal(dates()['6'], '2026-08-14');
});

test('"zuletzt gestempelt" sorts by date, then without date, then open', () => {
    toggle(2, true);
    choose($('#passSort'), 'recent');
    assert.deepEqual(order().slice(0, 6), [2, 10, 11, 6, 5, 1]);
    choose($('#passSort'), 'number');
    assert.deepEqual(order().slice(0, 3), [1, 2, 3]);
});

test('"Dieses Jahr" counts the dates of the current year', () => {
    const year = today.slice(0, 4);
    const expected = Object.values(dates()).filter(d => d.startsWith(year)).length;
    assert.equal(passStats()['Dieses Jahr'], String(expected));
});

test('the Tourenplan sets the date for a whole suggestion and for a walked own tour', async () => {
    await startTourPlan();
    const a1 = tourById('A1');
    setChecked($('.tour-row[data-id="A1"] .tour-done'), true);
    assert.equal(rowState('A1').checked, true);
    assert.ok(a1.stamps.every(n => dates()[String(n)] === today));
});

test('export v4 carries the dates, older files import without dates', async () => {
    $('#progressExport').click();
    const data = JSON.parse(env.downloads.at(-1));
    assert.equal(data.version, 4);
    assert.deepEqual(data.stampDates, dates());

    await importProgressFile(JSON.stringify({ format: 'hwn-tourenplan-progress', version: 3, stamps: [5, 6] }));
    assert.deepEqual(dates(), {});
    assert.equal(text(tile(6).querySelector('.pass-date')), 'Datum?');

    await importProgressFile(JSON.stringify({
        format: 'hwn-tourenplan-progress', version: 4, stamps: [5, 6],
        stampDates: { 5: '2024-05-01', 6: 'gestern', 8: '2024-05-01' }
    }));
    assert.deepEqual(dates(), { 5: '2024-05-01' });
});
