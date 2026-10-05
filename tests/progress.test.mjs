// Progress per stamp (plan step 1): migration from tour-based storage, single stamps,
// partially collected suggestions, suggestion wording, season tags, export v4 and import of older files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    setupBrowser, startTourPlan, tourById, plan, SRC, $, $$, tick, text, row, rowState, setChecked,
    importProgressFile, stats, readJSON
} from './helpers/browser.mjs';

// A browser that still has the old keys: finished tours plus stamps collected outside of them
const env = setupBrowser({ storage: { 'hwn-tours-done': '["B7","B8","D8"]', 'hwn-stamps-extra': '[14,20,21]' } });
const collectedInStore = () => JSON.parse(env.store['hwn-stamps-collected']);
await startTourPlan();

test('migrates finished tours and extra stamps to collected stamps', () => {
    const expected = new Set([...tourById('B7').stamps, ...tourById('B8').stamps, ...tourById('D8').stamps, 14, 20, 21]);
    assert.deepEqual(new Set(collectedInStore()), expected);
    assert.equal(stats()['Stempel gesammelt'], String(expected.size));
    assert.equal(stats()['Vorschläge erledigt'], '3');
    assert.deepEqual(rowState('B7'), { checked: true, partial: false, count: '' });
});

test('labels tours as suggestions and ORS tracks as unchecked route suggestions', async () => {
    row('A1').click();
    await tick();
    assert.match(text($('#tourDetail h3')), /^Vorschlag A1/);
    assert.ok($('#tourDetail .suggestion-hint'));
    assert.match(text($('#tourDetail .track-source')), /^Routenvorschlag \(OpenRouteService, ungeprüft\)/);
});

test('single stamps can be collected and make a suggestion partial', async () => {
    row('A1').click();
    await tick();
    setChecked($('#tourDetail .stamp-done[data-stamp="129"]'), true);
    setChecked($('#tourDetail .stamp-done[data-stamp="130"]'), true);
    assert.deepEqual(rowState('A1'), { checked: false, partial: true, count: '2/4' });
    assert.match(text($('#tourDetail h3')), /2\/4 gestempelt/);
    assert.equal($('#tourDoneToggle').indeterminate, true);
});

test('the suggestion checkbox collects and removes all of its stamps', async () => {
    setChecked($('#tourDoneToggle'), true);
    assert.deepEqual(rowState('A1'), { checked: true, partial: false, count: '' });
    setChecked(row('A1').querySelector('.tour-done'), false);
    assert.deepEqual(rowState('A1'), { checked: false, partial: false, count: '' });
    assert.ok(tourById('A1').stamps.every(n => !collectedInStore().includes(n)));
});

test('project tracks from Komoot are labelled as project tracks', async () => {
    row('B7').click();
    await tick();
    assert.match(text($('#tourDetail .track-source')), /^Track aus dem Projekt/);
});

test('season tag follows the highest point of the track', async () => {
    const { analyzeTrack } = await import('../src/utils/tracks.js');
    const season = ele => ele < 600 ? 'ganzjährig' : ele < 800 ? 'Apr–Nov' : 'Mai–Okt';
    const withTrack = plan.tours.filter(t => !t.single && fs.existsSync(`${SRC}data/tours/${t.id}.gpx`));
    assert.ok(withTrack.length > 0);
    for (const tour of withTrack) {
        const { maxEle } = analyzeTrack(fs.readFileSync(`${SRC}data/tours/${tour.id}.gpx`, 'utf8'), []);
        row(tour.id).click();
        await tick();
        assert.equal($$('#tourDetail .tips b')[0].textContent, `${season(maxEle ?? tour.maxEle)}:`, tour.id);
    }
});

test('a single-stamp suggestion is done with its stamp', async () => {
    row('G1').click();
    await tick();
    setChecked($('#tourDetail .stamp-done[data-stamp="96"]'), true);
    assert.equal(rowState('G1').checked, true);
});

test('export v4 has the stamps, their dates and the derived finished suggestions', () => {
    $('#progressExport').click();
    const data = JSON.parse(env.downloads.at(-1));
    assert.equal(data.format, 'hwn-tourenplan-progress');
    assert.equal(data.version, 4);
    // Migrated stamps have no date, the ones collected in this test today
    assert.ok(Object.keys(data.stampDates).every(n => data.stamps.includes(Number(n))));
    assert.ok(data.stampDates['96']);
    assert.equal(data.stampDates['14'], undefined);
    assert.deepEqual(data.stamps, [...collectedInStore()].sort((a, b) => a - b));
    assert.deepEqual(data.doneTours, ['B7', 'B8', 'D8', 'G1']);
});

test('imports a v1 file and replaces the browser state', async () => {
    const file = { format: 'hwn-tourenplan-progress', version: 1, doneTours: ['B7', 'B8', 'D8'], stamps: [6, 7, 8, 14, 16, 20, 21, 30, 71, 72, 178] };
    await importProgressFile(JSON.stringify(file));
    assert.match($('#progressStatus').textContent, /^Importiert: 3 Vorschläge erledigt, 11 Stempel gesammelt/);
    assert.equal(rowState('G1').checked, false);
});

test('a finished tour in an older file counts with all of its stamps', async () => {
    await importProgressFile(JSON.stringify({ format: 'hwn-tourenplan-progress', version: 1, doneTours: ['A1'], stamps: [5] }));
    assert.match($('#progressStatus').textContent, /1 Vorschlag erledigt, 5 Stempel gesammelt/);
    assert.equal(rowState('A1').checked, true);
});

test('rejects files that are not a progress export', async () => {
    await importProgressFile(JSON.stringify({ format: 'hwn-tourenplan-progress', doneTours: 'x', stamps: [] }));
    assert.equal($('#progressStatus').textContent, 'Datei ist kein HWN-Fortschritt-Export.');
});

test('the draft progress file in the repository can be imported', async () => {
    const draft = readJSON('../draft/hwn-fortschritt.json');
    await importProgressFile(JSON.stringify(draft));
    assert.match($('#progressStatus').textContent, /^Importiert:/);
});
