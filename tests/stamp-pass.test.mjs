// "Meine Stempel": all stamps at a glance, toggling single stamps, entering a list of numbers,
// search and filter, and the shared progress with the Tourenplan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupBrowser, startTourPlan, stamps, tourById, SRC, $, $$, tick, text, setChecked, isRenderedChecked, rowState, stats
} from './helpers/browser.mjs';

const env = setupBrowser({ storage: { 'hwn-stamps-collected': '[1,2]' } });
const collectedInStore = () => JSON.parse(env.store['hwn-stamps-collected']).sort((a, b) => a - b);
const pass = await import(SRC + 'components/stamppass.js');
await pass.showStampPass(stamps);

const tile = n => $(`.pass-stamp[data-stamp="${n}"]`);
const passStats = () => Object.fromEntries($$('#passStats .route-stat').map(d => [d.querySelector('.label').textContent, text(d.querySelector('.value'))]));
const visibleTiles = () => $$('.pass-stamp').filter(t => !t.hidden).map(t => Number(t.dataset.stamp));
const bulk = value => {
    $('#passBulkInput').value = value;
    $('#passBulk').dispatchEvent(new Event('submit'));
};

test('shows every stamp in number order with the collected ones marked', () => {
    assert.equal($$('.pass-stamp').length, stamps.length);
    assert.deepEqual($$('.pass-stamp').map(t => Number(t.dataset.stamp)), stamps.map(s => s.number).sort((a, b) => a - b));
    assert.ok(tile(1).classList.contains('got'));
    assert.ok(isRenderedChecked(tile(2).querySelector('.pass-done')));
    assert.ok(!tile(3).classList.contains('got'));
    assert.equal(passStats()['Stempel gesammelt'], `2 / ${stamps.length}`);
    assert.equal(passStats()['Offene Stempel'], String(stamps.length - 2));
});

test('ticking a stamp stores it', () => {
    setChecked(tile(5).querySelector('.pass-done'), true);
    assert.deepEqual(collectedInStore(), [1, 2, 5]);
    assert.ok(tile(5).classList.contains('got'));
    setChecked(tile(5).querySelector('.pass-done'), false);
    assert.deepEqual(collectedInStore(), [1, 2]);
});

test('parses numbers, ranges and HWN ids', () => {
    assert.deepEqual(pass.parseNumbers('3, 17;HWN020 120-122 9–9'), { numbers: [3, 17, 20, 120, 121, 122, 9], invalid: [] });
    assert.deepEqual(pass.parseNumbers('0 223 abc 5-3').invalid, ['0', '223', 'abc', '5-3']);
});

test('enters a list of numbers and can undo it', () => {
    bulk('2, 10-12, 999');
    assert.deepEqual(collectedInStore(), [1, 2, 10, 11, 12]);
    assert.match($('#passBulkStatus').textContent, /^3 Stempel eingetragen, 1 war schon gestempelt\. Ignoriert: 999/);
    assert.equal($('#passUndo').hidden, false);
    $('#passUndo').click();
    assert.deepEqual(collectedInStore(), [1, 2]);
    assert.equal($('#passUndo').hidden, true);
    bulk('abc');
    assert.ok($('#passBulkStatus').classList.contains('error'));
});

test('filters by status and searches by number or name', () => {
    $('#passFilter [data-filter="got"]').click();
    assert.deepEqual(visibleTiles(), [1, 2]);
    assert.equal(text($('#passFilter [data-filter="got"] .mono')), '2');
    $('#passFilter [data-filter="open"]').click();
    assert.equal(visibleTiles().length, stamps.length - 2);
    $('#passFilter [data-filter="all"]').click();

    $('#passSearch').value = '17';
    $('#passSearch').dispatchEvent(new Event('input'));
    assert.deepEqual(visibleTiles(), [17]);
    const name = stamps.find(s => s.number === 40).name;
    $('#passSearch').value = name.toUpperCase();
    $('#passSearch').dispatchEvent(new Event('input'));
    assert.ok(visibleTiles().includes(40));
    $('#passSearch').value = 'gibt es nicht';
    $('#passSearch').dispatchEvent(new Event('input'));
    assert.equal($('#passEmpty').hidden, false);
    $('#passSearch').value = '';
    $('#passSearch').dispatchEvent(new Event('input'));
});

test('stamps link to their suggestion', () => {
    const a1 = tourById('A1');
    let shown = null;
    document.addEventListener('hwn:show-tour', e => { shown = e.detail.id; }, { once: true });
    tile(a1.stamps[0]).querySelector('.pass-tour').click();
    assert.equal(shown, 'A1');
});

test('shares the progress with the Tourenplan both ways', async () => {
    const a1 = tourById('A1');
    bulk(String(a1.stamps[0]));
    await startTourPlan();
    assert.equal(stats()['Stempel gesammelt'], '3');
    assert.equal(rowState('A1').partial, true);

    // Collecting the whole suggestion in the Tourenplan shows up on the stamp page
    setChecked($('.tour-row[data-id="A1"] .tour-done'), true);
    await tick();
    assert.ok(a1.stamps.every(n => tile(n).classList.contains('got')));

    // And ticking on the stamp page updates the open Tourenplan
    setChecked(tile(a1.stamps[1]).querySelector('.pass-done'), false);
    assert.equal(rowState('A1').partial, true);
    assert.equal(stats()['Stempel gesammelt'], String(2 + a1.stamps.length - 1));
});
