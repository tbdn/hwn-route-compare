// Suggestions adapt (plan step 3): rest of a suggestion when stamps are collected or planned in
// own tours, every open stamp counted once in "km offen", rest routing and adopting a suggestion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupBrowser, startTourPlan, tourById, $, $$, tick, text, row, rowCells, setChecked,
    pickFile, stats, parseDe, loopGpx, stampByNumber
} from './helpers/browser.mjs';

const env = setupBrowser();
await startTourPlan();
const { setApiKey } = await import('../src/utils/routing.js');
const openKm = () => parseDe(stats()['km offen']);
const ownKm = name => parseDe(text($$('.own-card .tour-row').find(r => r.textContent.includes(name)).querySelectorAll('td')[2]));

// Straight-line loop x 1.4, as the app estimates a rest
function estimateKm(numbers) {
    const r = x => x * Math.PI / 180;
    const pts = numbers.map(n => stampByNumber.get(n));
    let m = 0;
    pts.forEach((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
        m += 2 * 6371000 * Math.asin(Math.sqrt(h));
    });
    return m * 1.4 / 1000;
}

const startKm = openKm();
// Komoot project tracks (B7, D8) already make their open stamps "verplant"
const plannedBefore = Number(stats()['davon verplant'] || 0);
const a1Km = parseDe(rowCells('A1').km);

test('a planned own tour leaves only the rest of the suggestion', async () => {
    await pickFile($('#ownFile'), 'runde.gpx', loopGpx([129, 130], 'Meine Runde'));
    $('#ownForm').dispatchEvent(new Event('submit'));
    await tick();

    assert.ok(plannedBefore > 0);
    assert.equal(stats()['davon verplant'], String(plannedBefore + 2));
    assert.ok(Math.abs(parseDe(rowCells('A1').km) - estimateKm([105, 113])) < 0.1);
    assert.match(rowCells('A1').km, /^~/);
    assert.equal(row('A1').querySelectorAll('td')[2].getAttribute('title'), 'Rest: 105, 113 (geschätzt)');
    assert.deepEqual($$('.tour-row[data-id="A1"] .seq-stop').map(s => s.className.replace('seq-stop', '').trim()), ['planned', 'planned', '', '']);
});

test('every open stamp counts once: own tour plus rest instead of the whole suggestion', () => {
    const expected = startKm - a1Km + ownKm('Meine Runde') + estimateKm([105, 113]);
    assert.ok(Math.abs(openKm() - expected) <= 1, `${openKm()} vs ${expected}`);
});

test('the detail shows what is planned and what is left', async () => {
    row('A1').click();
    await tick();
    const box = text($('#tourDetail .rest-box ul'));
    assert.match(box, /Verplant in „Meine Runde“: 129 Weltwald, 130 Iberger Albert-Turm/);
    assert.match(box, /Rest: 105 Prinzenlaube, 113 Grumbacher Teich · ~/);
    assert.ok($('#restRoute'));
});

test('after walking the own tour its stamps are collected, the rest stays', async () => {
    setChecked($('.own-card .tour-row .tour-done'), true);
    row('A1').click();
    await tick();
    assert.match(text($('#tourDetail .rest-box ul')), /^Gesammelt: 129 Weltwald, 130 Iberger Albert-Turm/);
    assert.ok(Math.abs(openKm() - (startKm - a1Km + estimateKm([105, 113]))) <= 1);
});

test('routing the rest needs an API key', async () => {
    $('#restRoute').click();
    await tick();
    assert.match(text($('#tourDetail .track-warning')), /OpenRouteService-API-Schlüssel/);
});

test('the routed rest becomes a planned own tour and empties the suggestion', async () => {
    setApiKey('test');
    row('A1').click();
    await tick();
    $('#restRoute').click();
    await tick(150);

    const body = env.ors.calls.at(-1).body;
    assert.equal(body.coordinates.length, 3, 'rest stamps plus the way back');
    assert.deepEqual(body.coordinates[0], body.coordinates.at(-1));
    assert.match(text($('#tourDetail h3')), /^A1 – Rest geplant/);
    assert.match(text($('#tourDetail .track-source')), /Weg von OpenRouteService \(ungeprüft\)/);
    assert.deepEqual(rowCells('A1'), { km: '–', hours: '–', ascent: '–' });
});

test('only suggestions with a track can be adopted', async () => {
    row('G1').click();
    await tick();
    assert.equal($('#tourAdopt'), null);
    row('B7').click();
    await tick();
    assert.ok($('#tourAdopt'));
});

test('adopting a suggestion copies track and Komoot links; open distance stays the same', async () => {
    const before = stats()['km offen'];
    $('#tourAdopt').click();
    await tick(150);
    assert.match(text($('#tourDetail h3')), /^B7 – eigene Variante geplant/);
    assert.deepEqual($$('#tourDetail .komoot-links a').map(a => text(a)), (tourById('B7').komoot || []).map(l => `${l.name} →`));
    assert.equal(stats()['km offen'], before);
    assert.equal(rowCells('B7').km, '–');
});

test('a part tour shows its rest as well', async () => {
    row('D7a').click();
    await tick();
    setChecked($('#tourDetail .stamp-done[data-stamp="64"]'), true);
    const rest = tourById('D7').parts[0].stamps.filter(n => n !== 64);
    assert.ok(Math.abs(parseDe(rowCells('D7a').km) - estimateKm(rest)) < 0.1);
    assert.match(text($('#tourDetail .rest-box ul')), /^Gesammelt: 64 Böser Kleef/);
});
