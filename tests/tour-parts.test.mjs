// Part tours of long suggestions (plan step 1b): variant switch, default variant from tours.json,
// part detail, progress through parts, statistics per variant, export/import of the chosen variants.
// The tours used are picked from the data: one walked whole by default, one in parts by default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupBrowser, startTourPlan, plan, $, $$, tick, text, row, rowState, rowCells, setChecked,
    importProgressFile, stats, parseDe
} from './helpers/browser.mjs';

const env = setupBrowser();
await startTourPlan();
const variantsInStore = () => JSON.parse(env.store['hwn-tour-variants'] || '{}');
const split = plan.tours.filter(t => t.parts?.length);
// T: walked whole by default, P: walked in parts by default, O: another whole-by-default tour
const [T, O] = split.filter(t => t.defaultVariant !== 'parts');
const P = split.find(t => t.defaultVariant === 'parts');
const [Ta, Tb] = T.parts;

test('every split tour lists its parts below it', () => {
    assert.ok(split.length > 0);
    assert.deepEqual($$('.part-row').map(r => r.dataset.id), split.flatMap(t => t.parts.map(p => p.id)));
    assert.match(text(row(T.id).querySelector('.tour-id')), /2 Teile/);
});

test('parts of a split tour cover exactly its stamps', () => {
    for (const tour of split) {
        assert.deepEqual(tour.parts.flatMap(p => p.stamps).sort(), [...tour.stamps].sort(), tour.id);
    }
});

test('a tour with defaultVariant "parts" starts in parts and marks that as recommended', async () => {
    assert.ok(P, 'tours.json has a tour with defaultVariant "parts"');
    assert.equal(row(P.id).classList.contains('variant-off'), true);
    assert.equal(row(P.parts[0].id).classList.contains('variant-off'), false);
    row(P.id).click();
    await tick();
    assert.match(text($('#tourDetail .variant-box')), /In zwei Teilen \(empfohlen\)/);
    assert.deepEqual(variantsInStore(), {}, 'the default is not stored');
});

test('choosing whole for a parts-by-default tour is stored, going back to the default removes it', async () => {
    setChecked($('#tourDetail input[name="tourVariant"][value="whole"]'), true);
    await tick();
    assert.deepEqual(variantsInStore(), { [P.id]: 'whole' });
    assert.equal(row(P.id).classList.contains('variant-off'), false);

    row(P.id).click();
    await tick();
    setChecked($('#tourDetail input[name="tourVariant"][value="parts"]'), true);
    await tick();
    assert.deepEqual(variantsInStore(), {});
});

test('a tour without default is walked whole until the parts variant is chosen', async () => {
    assert.equal(row(T.id).classList.contains('variant-off'), false);
    assert.equal(row(Ta.id).classList.contains('variant-off'), true);
    row(T.id).click();
    await tick();
    assert.match(text($('#tourDetail .variant-box')), /Komplett/);
    assert.doesNotMatch(text($('#tourDetail .variant-box')), /empfohlen/);
    assert.equal($$('#tourDetail .part-link').length, 2);
});

test('switching to parts counts the parts in the open distance instead of the whole tour', async () => {
    const beforeText = stats()['km offen'];
    const before = parseDe(beforeText);
    const whole = parseDe(rowCells(T.id).km);
    setChecked($('#tourDetail input[name="tourVariant"][value="parts"]'), true);
    await tick();
    assert.deepEqual(variantsInStore(), { [T.id]: 'parts' });
    const parts = T.parts.reduce((a, p) => a + parseDe(rowCells(p.id).km), 0);
    assert.ok(Math.abs(parseDe(stats()['km offen']) - (before - whole + parts)) <= 1);
    // Parts without a project track are estimates ("~")
    const partWithoutTrack = T.parts.some(p => !row(p.id).querySelector('.tour-id').textContent.includes('GPX'));
    if (!beforeText.startsWith('~')) assert.equal(stats()['km offen'].startsWith('~'), partWithoutTrack);
    assert.equal(row(T.id).classList.contains('variant-off'), true);
    assert.equal(row(Ta.id).classList.contains('variant-off'), false);
});

test('a part has its own detail with stamps, checkbox and track actions', async () => {
    $(`#tourDetail [data-part="${Tb.id}"]`).click();
    await tick();
    assert.match(text($('#tourDetail h3')), new RegExp(`^Teil ${Tb.id}`));
    assert.ok($('#komootPlan'), 'parts can be planned in Komoot');
    assert.ok($('#trackUpload'));
    assert.equal($$('#tourDetail .stamp-done').length, Tb.stamps.length);
});

test('a suggestion is done only when both parts are collected', async () => {
    setChecked($('#tourDoneToggle'), true);
    assert.equal(rowState(Tb.id).checked, true);
    assert.deepEqual(rowState(T.id), { checked: false, partial: true, count: `${Tb.stamps.length}/${T.stamps.length}` });

    $('#tourParent').click();
    await tick();
    assert.match(text($('#tourDetail h3')), new RegExp(`^Gruppe ${T.id}`));

    row(Ta.id).click();
    await tick();
    setChecked($('#tourDoneToggle'), true);
    assert.equal(rowState(T.id).checked, true);
    assert.equal(stats()['Gruppen erledigt'], '1');
});

test('walked distance follows the chosen variant', async () => {
    const parts = T.parts.reduce((a, p) => a + parseDe(rowCells(p.id).km), 0);
    assert.ok(Math.abs(parseDe(stats()['km zurückgelegt']) - parts) < 0.2);

    row(T.id).click();
    await tick();
    setChecked($('#tourDetail input[name="tourVariant"][value="whole"]'), true);
    await tick();
    assert.deepEqual(variantsInStore(), {});
    assert.equal(stats()['km zurückgelegt'], rowCells(T.id).km);
});

test('opening a part switches its tour to the parts variant', async () => {
    row(O.parts[1].id).click();
    await tick();
    assert.deepEqual(variantsInStore(), { [O.id]: 'parts' });
});

test('variants are exported and imported, unknown ones are dropped', async () => {
    $('#progressExport').click();
    const data = JSON.parse(env.downloads.at(-1));
    assert.deepEqual(data.variants, { [O.id]: 'parts' });

    await importProgressFile(JSON.stringify({ ...data, variants: { [T.id]: 'parts', [P.id]: 'whole', XX: 'parts', A1: 'parts' } }));
    assert.deepEqual(variantsInStore(), { [T.id]: 'parts', [P.id]: 'whole' });
});
