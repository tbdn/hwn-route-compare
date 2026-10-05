// "Verplant" (plan "Stempel" step 4): open stamps count as planned only with a Komoot track or a track
// from another service; OpenRouteService tracks are unchecked suggestions and app straight lines no way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    setupBrowser, startTourPlan, stamps, tourById, plan, SRC, $, $$, tick, text, importProgressFile, loopGpx, row, stats
} from './helpers/browser.mjs';

setupBrowser();
const tracks = await import(SRC + 'utils/tracks.js');
const tourplan = await import(SRC + 'components/tourplan.js');
const pass = await import(SRC + 'components/stamppass.js');
const { generateGPX } = await import(SRC + 'utils/optimize.js');

const projectGpx = id => fs.readFileSync(`${SRC}data/tours/${id}.gpx`, 'utf8');
const komoot = gpx => gpx.replace('<gpx>', '<gpx version="1.1" creator="https://www.komoot.de">');
const ors = gpx => gpx.replace('<gpx>', '<gpx version="1.1" creator="HWN Route Compare (OpenRouteService)">');
const plannedTiles = () => $$('.pass-stamp.planned').map(t => Number(t.dataset.stamp)).sort((a, b) => a - b);
const planOf = n => {
    const b = $(`.pass-stamp[data-stamp="${n}"] .pass-plan`);
    return b.hidden ? null : { text: text(b), unit: b.dataset.unit, unchecked: b.classList.contains('unchecked') };
};
const importState = ({ stamps: s = [], tracks: t = {}, ownTours = [], variants = {} } = {}) =>
    importProgressFile(JSON.stringify({ format: 'hwn-tourenplan-progress', version: 4, stamps: s, tracks: t, ownTours, variants, komoot: {} }));

// Stamps of a unit that its project file passes (Komoot files of B7 and D8)
const onTrack = id => {
    const unit = tourById(id);
    const missed = new Set(tracks.analyzeTrack(projectGpx(id), unit.stamps.map(n => stamps.find(s => s.number === n))).missed.map(m => m.number));
    return unit.stamps.filter(n => !missed.has(n));
};
const komootProjectStamps = plan.tours
    .filter(t => fs.existsSync(`${SRC}data/tours/${t.id}.gpx`) && tracks.trackOrigin(projectGpx(t.id)) === 'komoot')
    .flatMap(t => onTrack(t.id)).sort((a, b) => a - b);

await pass.showStampPass(stamps);
await tourplan.loadPlanTracks();
await tick();

test('the origin of a track is read from its head', () => {
    assert.equal(tracks.trackOrigin(projectGpx('A1')), 'ors');
    assert.equal(tracks.trackOrigin(projectGpx('B7')), 'komoot');
    assert.equal(tracks.trackOrigin(generateGPX(stamps.slice(0, 3))), 'app');
    assert.equal(tracks.trackOrigin('<?xml version="1.0"?><gpx version="1.1" creator="Garmin Connect"><trk/></gpx>'), 'external');
    assert.equal(tracks.trackOrigin('<gpx version="1.1"><trk/></gpx>'), 'external');
    assert.equal(tracks.trackOrigin('<gpx creator="x"><metadata><author><link href="https://www.komoot.de"/></author></metadata></gpx>'), 'komoot');
});

test('Komoot project tracks make their stamps planned, ORS suggestions do not (stamp page first)', () => {
    assert.ok(komootProjectStamps.length > 0);
    assert.deepEqual(plannedTiles(), komootProjectStamps);
    assert.deepEqual(planOf(komootProjectStamps[0]), { text: 'verplant', unit: plan.tours.find(t => t.stamps.includes(komootProjectStamps[0])).id, unchecked: false });
    tourById('A1').stamps.forEach(n => assert.equal(planOf(n), null));
});

test('the "Verplant" filter and figure', () => {
    $('#passFilter [data-filter="planned"]').click();
    assert.deepEqual($$('.pass-stamp').filter(t => !t.hidden).map(t => Number(t.dataset.stamp)).sort((a, b) => a - b), komootProjectStamps);
    assert.equal(text($('#passFilter [data-filter="planned"] .mono')), String(komootProjectStamps.length));
    $('#passFilter [data-filter="all"]').click();
    const figure = $$('#passStats .route-stat').find(d => d.querySelector('.label').textContent === 'davon verplant');
    assert.equal(text(figure.querySelector('.value')), String(komootProjectStamps.length));
});

test('a collected stamp is never planned', () => {
    tourplan.setStampsCollected([komootProjectStamps[0]], true);
    assert.equal(planOf(komootProjectStamps[0]), null);
    tourplan.setStampsCollected([komootProjectStamps[0]], false);
});

test('an uploaded Komoot track plans a suggestion; a stamp it misses stays open', async () => {
    const [first, ...rest] = tourById('A1').stamps;
    await importState({ tracks: { A1: { name: 'A1.gpx', gpx: komoot(loopGpx(rest)) } } });
    rest.forEach(n => assert.equal(planOf(n)?.text, 'verplant', `stamp ${n}`));
    assert.equal(planOf(first), null, 'missed by the track');
});

test('an own tour plans its stamps with a checked track, not with an ORS track', async () => {
    const own = gpx => ({ id: 'own-1', name: 'Meine Runde', gpx, fileName: 'runde.gpx', stamps: [129, 130], status: 'planned', createdAt: '2026-09-01' });
    await importState({ ownTours: [own(loopGpx([129, 130]))] });
    assert.deepEqual(planOf(129), { text: 'verplant', unit: 'own-1', unchecked: false });

    await importState({ ownTours: [own(ors(loopGpx([129, 130])))] });
    assert.deepEqual(planOf(129), { text: 'eigene Tour', unit: 'own-1', unchecked: true });
    assert.ok(!plannedTiles().includes(129));
});

test('the Tourenplan keeps the ORS own tour out of the rest, but calls it unchecked', async () => {
    await startTourPlan();
    assert.equal(stats()['davon verplant'], String(komootProjectStamps.length));
    row('A1').click();
    await tick();
    assert.match(text($('#tourDetail .rest-box ul')), /In eigener Tour „Meine Runde“ \(Track ungeprüft\): 129 Weltwald, 130 Iberger Albert-Turm/);
    assert.match(text($('#tourDetail .rest-box ul')), /Rest: 105 Prinzenlaube, 113 Grumbacher Teich/);
    const seq = $$('.tour-row[data-id="A1"] .seq-stop');
    assert.equal(seq[0].className, 'seq-stop planned unchecked');
    assert.match(seq[0].getAttribute('title'), /Track ungeprüft/);
});

test('a part tour counts only in the chosen variant', async () => {
    const part = tourById('A5').parts[0];
    const upload = { [part.id]: { name: `${part.id}.gpx`, gpx: komoot(loopGpx(part.stamps)) } };
    await importState({ tracks: upload });
    assert.equal(planOf(part.stamps[0])?.unit, part.id, 'parts are the default for A5');
    await importState({ tracks: upload, variants: { A5: 'whole' } });
    assert.equal(planOf(part.stamps[0]), null);
});

test('clearing browser tracks removes the plans they made', async () => {
    const [, ...rest] = tourById('A1').stamps;
    await importState({ tracks: { A1: { name: 'A1.gpx', gpx: komoot(loopGpx(rest)) } } });
    assert.equal(planOf(rest[0])?.text, 'verplant');
    $('#uploadsClear').click();
    $('#uploadsClearYes').click();
    await tick();
    assert.equal(planOf(rest[0]), null);
    assert.deepEqual(plannedTiles(), komootProjectStamps);
});

test('a Komoot link without a track hints at the missing GPX, a Komoot track does not need it', async () => {
    await importProgressFile(JSON.stringify({
        format: 'hwn-tourenplan-progress', version: 4, stamps: [], tracks: {}, ownTours: [], variants: {},
        komoot: { A1: [{ url: 'https://www.komoot.com/de-de/tour/123456', name: '' }] }
    }));
    row('A1').click();
    await tick();
    assert.match(text($('#tourDetail .komoot-box')), /GPX aus Komoot hinterlegen, damit die Stempel als verplant zählen/);
    tourById('A1').stamps.forEach(n => assert.equal(planOf(n), null));
    row('B7').click();
    await tick();
    assert.doesNotMatch(text($('#tourDetail .komoot-box')), /GPX aus Komoot hinterlegen/);
});
