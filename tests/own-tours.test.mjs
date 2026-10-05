// Own tours (plan step 2): create from GPX with stamp detection, walked status, statistics,
// editing, deleting, export/import. Example from the plan: a round over stamps 129 and 130 only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupBrowser, startTourPlan, $, $$, tick, text, row, rowState, setChecked, isRenderedChecked,
    pickFile, importProgressFile, stats, parseDe, loopGpx
} from './helpers/browser.mjs';

const env = setupBrowser();
await startTourPlan();
const { loadOwnTours } = await import('../src/utils/tracks.js');
const collectedInStore = () => JSON.parse(env.store['hwn-stamps-collected'] || '[]');
const formStamps = () => $$('.own-stamp').map(cb => `${cb.dataset.stamp}${isRenderedChecked(cb) ? '✓' : ''}`);
const ownRow = () => $('.own-card .tour-row');
let exported;

test('there is no own tour chip before the first own tour', () => {
    assert.ok(!$$('.region-chip').some(c => c.textContent.includes('Eigene Touren')));
});

test('a file without a track is rejected', async () => {
    await pickFile($('#ownFile'), 'kaputt.gpx', '<gpx><trk>');
    assert.match($('#ownStatus').textContent, /^GPX nicht übernommen/);
});

test('the form detects exactly the stamps along the track', async () => {
    await pickFile($('#ownFile'), '2026-10-01_3399999999_Meine_Runde.gpx', loopGpx([129, 130]));
    assert.equal(text($('#tourDetail h3')), 'Eigene Tour anlegen');
    assert.equal($('#ownName').value, 'Meine Runde', 'name from the Komoot file name without date and id');
    assert.deepEqual(formStamps(), ['129✓', '130✓']);
});

test('stamps can be added by number and unknown numbers are reported', async () => {
    $('#ownStampNumber').value = '105';
    $('#ownStampAdd').click();
    await tick();
    assert.deepEqual(formStamps(), ['129✓', '130✓', '105✓']);
    $('#ownStampNumber').value = '999';
    $('#ownStampAdd').click();
    await tick();
    assert.equal(text($('#tourDetail .own-form .track-warning')), 'Stempel 999 gibt es nicht.');
});

test('saving stores the tour with the chosen stamps and links Komoot', async () => {
    setChecked($('.own-stamp[data-stamp="105"]'), false);
    $('#ownName').value = 'Meine Runde 129/130';
    $('#ownName').dispatchEvent(new Event('input'));
    $('#ownForm').dispatchEvent(new Event('submit'));
    await tick();

    assert.match(text($('#tourDetail h3')), /^Meine Runde 129\/130 geplant/);
    assert.deepEqual((await loadOwnTours()).map(r => [r.name, r.stamps, r.status]), [['Meine Runde 129/130', [129, 130], 'planned']]);
    assert.deepEqual($$('#tourDetail .komoot-links a').map(a => a.href), ['https://www.komoot.com/de-de/tour/3399999999']);
    assert.ok($$('.region-chip').some(c => c.textContent.includes('Eigene Touren')));
    assert.match(text(ownRow()), /Meine Runde 129\/130/);
});

test('walked collects the stamps; the own tour counts as walked distance', async () => {
    const ownKm = parseDe(text(ownRow().querySelectorAll('td')[2]));
    setChecked($('#tourDoneToggle'), true);
    assert.deepEqual(collectedInStore(), [129, 130]);
    assert.deepEqual(rowState('A1'), { checked: false, partial: true, count: '2/4' });
    assert.ok(Math.abs(parseDe(stats()['km zurückgelegt']) - ownKm) < 0.1);
    assert.equal(stats()['Eigene Touren gelaufen'], '1/1');
});

test('a suggestion finished partly through an own tour is not counted again', async () => {
    const walked = stats()['km zurückgelegt'];
    setChecked(row('A1').querySelector('.tour-done'), true);
    assert.equal(stats()['km zurückgelegt'], walked);
    setChecked(row('A1').querySelector('.tour-done'), false);
    // unchecking the suggestion removed 129 and 130 again; walk the own tour once more
    ownRow().click();
    await tick();
    setChecked($('#tourDoneToggle'), false);
    setChecked($('#tourDoneToggle'), true);
    assert.deepEqual(collectedInStore(), [129, 130]);
});

test('editing keeps the stamps and offers no walked checkbox', async () => {
    $('#ownEdit').click();
    await tick();
    assert.equal(text($('#tourDetail h3')), 'Eigene Tour bearbeiten');
    assert.equal($('#ownWalked'), null);
    assert.deepEqual(formStamps(), ['129✓', '130✓']);
    $('#ownCancel').click();
    await tick();
});

test('export contains the own tour and its Komoot link', () => {
    $('#progressExport').click();
    exported = JSON.parse(env.downloads.at(-1));
    assert.match($('#progressStatus').textContent, /mit 1 eigenen Tour/);
    assert.deepEqual(exported.ownTours.map(r => [r.name, r.status]), [['Meine Runde 129/130', 'walked']]);
    assert.deepEqual(Object.keys(exported.komoot), [exported.ownTours[0].id]);
});

test('deleting asks in the panel and keeps the collected stamps', async () => {
    $('#ownDelete').click();
    await tick();
    assert.match(text($('#tourDetail .own-confirm')), /wirklich löschen\? Die gesammelten Stempel bleiben erhalten/);
    $('#ownDeleteYes').click();
    await tick();
    assert.equal($$('.own-card').length, 0);
    assert.deepEqual(collectedInStore(), [129, 130]);
    assert.equal(env.store['hwn-komoot-links'], '{}');
});

test('import restores own tours and their Komoot links', async () => {
    await importProgressFile(JSON.stringify(exported));
    assert.match($('#progressStatus').textContent, /1 eigene Tour\.$/);
    assert.equal($$('.own-card .tour-row').length, 1);
    assert.deepEqual(Object.keys(JSON.parse(env.store['hwn-komoot-links'])), [exported.ownTours[0].id]);
});

test('undoing walked removes the stamps again', async () => {
    ownRow().click();
    await tick();
    setChecked($('#tourDoneToggle'), false);
    assert.deepEqual(collectedInStore(), []);
});

test('editing with another GPX keeps id and name and detects the new stamps', async () => {
    $('#ownEdit').click();
    await tick();
    await pickFile($('#ownFile'), 'neu.gpx', loopGpx([105, 113], 'Anderer Name'));
    assert.equal($('#ownName').value, 'Meine Runde 129/130');
    assert.deepEqual(formStamps(), ['105✓', '113✓']);
    $('#ownForm').dispatchEvent(new Event('submit'));
    await tick();
    assert.deepEqual((await loadOwnTours()).map(r => [r.id, r.stamps, r.fileName]), [[exported.ownTours[0].id, [105, 113], 'neu.gpx']]);
});
