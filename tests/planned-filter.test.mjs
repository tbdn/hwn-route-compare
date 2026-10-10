// Tourenplan: the "Geplant" chip shows what is planned to walk — open suggestions or parts with a Komoot
// (or other checked) track and own tours that are not walked yet. OpenRouteService tracks don't count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupBrowser, startTourPlan, plan, SRC, $, $$, tick, text, importProgressFile, loopGpx, tourById, row, parseDe } from './helpers/browser.mjs';

setupBrowser();
const { trackOrigin } = await import(SRC + 'utils/tracks.js');
const mod = await startTourPlan();
await mod.loadPlanTracks();
await tick();

const chip = () => $$('.region-chip').find(c => c.dataset.code === 'planned');
const chipCount = () => Number(text(chip()).match(/\((\d+)\)/)[1]);
const visibleRows = () => $$('.tour-row').filter(r => !r.hidden && !r.closest('.region-card').hidden).map(r => r.dataset.id).sort();
const komootTours = plan.tours
    .filter(t => fs.existsSync(`${SRC}data/tours/${t.id}.gpx`) && trackOrigin(fs.readFileSync(`${SRC}data/tours/${t.id}.gpx`, 'utf8')) === 'komoot')
    .map(t => t.id).sort();

test('the chip counts open suggestions with a Komoot track and shows only them', () => {
    assert.ok(komootTours.length > 0);
    assert.equal(chipCount(), komootTours.length);
    chip().click();
    assert.equal(chip().getAttribute('aria-pressed'), 'true');
    assert.deepEqual(visibleRows(), komootTours);
    assert.match(text($('#tourDetail h3')), /^Geplant$/);
    assert.deepEqual($$('#tourDetail [data-unit]').map(b => b.dataset.unit).sort(), komootTours);
});

test('a planned own tour joins, a finished tour leaves', async () => {
    const done = komootTours[0];
    await importProgressFile(JSON.stringify({
        format: 'hwn-tourenplan-progress', version: 4, stamps: tourById(done).stamps, tracks: {}, variants: {}, komoot: {},
        ownTours: [{ id: 'own-1', name: 'Runde', gpx: loopGpx([129, 130]), fileName: 'Runde.gpx', stamps: [129, 130], status: 'planned', createdAt: '2026-10-01' }]
    }));
    await tick();
    chip().click();
    const expected = [...komootTours.filter(id => id !== done), 'own-1'].sort();
    assert.equal(chipCount(), expected.length);
    assert.deepEqual(visibleRows(), expected);
});

test('an OpenRouteService track does not make a group planned', async () => {
    const gpx = loopGpx(tourById('A1').stamps).replace('<gpx>', '<gpx version="1.1" creator="HWN Route Compare (OpenRouteService)">');
    assert.equal(trackOrigin(gpx), 'ors');
    await importProgressFile(JSON.stringify({
        format: 'hwn-tourenplan-progress', version: 4, stamps: [], variants: {}, komoot: {}, ownTours: [],
        tracks: { A1: { name: 'ors.gpx', gpx, uploadedAt: '2026-10-01T00:00:00.000Z' } }
    }));
    await tick();
    chip().click();
    assert.ok(row('A1').querySelector('.gpx-tag'), 'A1 has the uploaded track');
    assert.ok(!visibleRows().includes('A1'));
});

test('the level shows its Leistungs-km (km + Hm/100) next to it, "~" when estimated', () => {
    // E1 has a Komoot track: real km and ascent from the cells of its row
    const effort = id => text(row(id).querySelector('.effort'));
    const [km, , hm] = [...row('E1').querySelectorAll('td')].slice(2, 5).map(td => parseDe(td.textContent));
    assert.match(effort('E1'), /^\d+,\d Leistungs-km$/);
    assert.ok(Math.abs(parseDe(effort('E1').split(' ')[0]) - (km + hm / 100)) <= 0.11, effort('E1'));
    assert.ok(row('E1').querySelector('.level'));
    // Without a track the figures are estimates
    const estimated = plan.tours.find(t => t.id !== 'A1' && !fs.existsSync(`${SRC}data/tours/${t.id}.gpx`) && !t.single);
    if (estimated) assert.match(effort(estimated.id), /^~\d+,\d Leistungs-km$/);
});
