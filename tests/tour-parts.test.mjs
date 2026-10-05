// Part tours of long suggestions (plan step 1b): variant switch, part detail, progress through
// parts, statistics per variant, export/import of the chosen variants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupBrowser, startTourPlan, tourById, plan, $, $$, tick, text, row, rowState, rowCells, setChecked,
    importProgressFile, stats, parseDe
} from './helpers/browser.mjs';

const env = setupBrowser();
await startTourPlan();
const variantsInStore = () => JSON.parse(env.store['hwn-tour-variants'] || '{}');
const A5 = tourById('A5');

test('every split tour lists its parts below it', () => {
    const withParts = plan.tours.filter(t => t.parts?.length);
    assert.ok(withParts.length > 0);
    assert.deepEqual($$('.part-row').map(r => r.dataset.id), withParts.flatMap(t => t.parts.map(p => p.id)));
    assert.match(text(row('A5').querySelector('.tour-id')), /2 Teile/);
});

test('parts of a split tour cover exactly its stamps', () => {
    for (const tour of plan.tours.filter(t => t.parts?.length)) {
        assert.deepEqual(tour.parts.flatMap(p => p.stamps).sort(), [...tour.stamps].sort(), tour.id);
    }
});

test('a tour is walked whole until the parts variant is chosen', async () => {
    assert.equal(row('A5').classList.contains('variant-off'), false);
    assert.equal(row('A5a').classList.contains('variant-off'), true);
    row('A5').click();
    await tick();
    assert.match(text($('#tourDetail .variant-box')), /Komplett/);
    assert.equal($$('#tourDetail .part-link').length, 2);
});

test('switching to parts counts the parts in the open distance instead of the whole tour', async () => {
    const before = parseDe(stats()['km offen']);
    const whole = parseDe(rowCells('A5').km);
    setChecked($('#tourDetail input[name="tourVariant"][value="parts"]'), true);
    await tick();
    assert.deepEqual(variantsInStore(), { A5: 'parts' });
    const parts = A5.parts.reduce((a, p) => a + parseDe(rowCells(p.id).km), 0);
    assert.ok(Math.abs(parseDe(stats()['km offen']) - (before - whole + parts)) <= 1);
    assert.match(stats()['km offen'], /^~/, 'parts without a track are estimated');
    assert.equal(row('A5').classList.contains('variant-off'), true);
    assert.equal(row('A5a').classList.contains('variant-off'), false);
});

test('a part has its own detail with stamps, checkbox and track actions', async () => {
    $('#tourDetail [data-part="A5b"]').click();
    await tick();
    assert.match(text($('#tourDetail h3')), /^Teil A5b/);
    assert.ok($('#trackRoute'), 'parts can be routed on hiking paths');
    assert.equal($$('#tourDetail .stamp-done').length, A5.parts[1].stamps.length);
});

test('a suggestion is done only when both parts are collected', async () => {
    setChecked($('#tourDoneToggle'), true);
    assert.equal(rowState('A5b').checked, true);
    assert.deepEqual(rowState('A5'), { checked: false, partial: true, count: `${A5.parts[1].stamps.length}/${A5.stamps.length}` });

    $('#tourParent').click();
    await tick();
    assert.match(text($('#tourDetail h3')), /^Vorschlag A5/);

    row('A5a').click();
    await tick();
    setChecked($('#tourDoneToggle'), true);
    assert.equal(rowState('A5').checked, true);
    assert.equal(stats()['Vorschläge erledigt'], '1');
});

test('walked distance follows the chosen variant', async () => {
    const parts = A5.parts.reduce((a, p) => a + parseDe(rowCells(p.id).km), 0);
    assert.ok(Math.abs(parseDe(stats()['km zurückgelegt']) - parts) < 0.2);

    row('A5').click();
    await tick();
    setChecked($('#tourDetail input[name="tourVariant"][value="whole"]'), true);
    await tick();
    assert.deepEqual(variantsInStore(), {});
    assert.equal(stats()['km zurückgelegt'], rowCells('A5').km);
});

test('opening a part switches its tour to the parts variant', async () => {
    row('D7b').click();
    await tick();
    assert.deepEqual(variantsInStore(), { D7: 'parts' });
});

test('variants are exported and imported, unknown ones are dropped', async () => {
    $('#progressExport').click();
    const data = JSON.parse(env.downloads.at(-1));
    assert.deepEqual(data.variants, { D7: 'parts' });

    await importProgressFile(JSON.stringify({ ...data, variants: { A5: 'parts', XX: 'parts', A1: 'parts' } }));
    assert.deepEqual(variantsInStore(), { A5: 'parts' });
});
