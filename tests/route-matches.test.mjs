// Routenabgleich: a route from elsewhere (e.g. Komoot) is checked against the suggestions in the Tourenplan
// (stamps, length, and the ways when the suggestion has a track).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupBrowser, SRC, $, $$, tick, text, loopGpx, tourById, stampByNumber, plan } from './helpers/browser.mjs';

const env = setupBrowser();
await import(SRC + 'app.js');
const { trackOverlap } = await import(SRC + 'utils/tracks.js');

async function compare(gpx, name) {
    document.dispatchEvent(new CustomEvent('hwn:compare-route', { detail: { gpx, name } }));
    await tick(800);
    assert.equal($('#status').textContent, 'Fertig.');
}
const match = id => $(`.match[data-id="${id}"]`);
const verdict = id => text(match(id).querySelector('.match-verdict'));

test('overlap of two tracks counts length, not points, and finds where they part', () => {
    const straight = [[[51.80, 10.50], [51.80, 10.55]]];        // ~3.5 km, two points only
    const dense = [Array.from({ length: 101 }, (_, i) => [51.80, 10.50 + i * 0.0005])];
    assert.ok(trackOverlap(straight, dense).share > 0.99);
    assert.ok(trackOverlap(dense, straight).share > 0.99);

    // Same start, then 1 km north instead of east
    const away = [[[51.80, 10.50], [51.80, 10.525], [51.809, 10.525]]];
    const r = trackOverlap(away, straight);
    assert.ok(r.share > 0.6 && r.share < 0.7, String(r.share));
    assert.equal(r.deviations.length, 1);
    assert.ok(r.offKm > 0.9 && r.offKm < 1);
});

test('the track of a suggestion fits itself; its part tours are covered by it', async () => {
    await compare(fs.readFileSync(SRC + 'data/tours/A2.gpx', 'utf8'), 'A2.gpx');
    assert.equal($('#matchSection').hidden, false);
    assert.equal($('.match').dataset.id, 'A2');
    assert.equal(verdict('A2'), 'passt');
    assert.match(text(match('A2')), /Stempel 6\/6/);
    assert.match(text(match('A2')), /zu 100 % auf deiner Route/);
    tourById('A2').parts.forEach(p => assert.equal(verdict(p.id), 'Vorschlag + mehr'));

    // The best match is drawn dashed on the map
    assert.ok(match('A2').classList.contains('shown'));
    const dashed = env.drawnLines.filter(l => l.options?.dashArray === '8 10');
    assert.equal(dashed.length, 1);
    assert.ok(dashed[0].points.flat().length > 100);
});

test('same stamps on other ways, and a route that reaches only some stamps', async () => {
    await compare(loopGpx(tourById('A1').stamps), 'Luftlinie.gpx');
    assert.equal($('.match').dataset.id, 'A1');
    assert.equal(verdict('A1'), 'andere Wege');

    await compare(loopGpx([129, 130]), 'Kurz.gpx');
    assert.equal(verdict('A1'), 'teilweise');
    assert.match(text(match('A1')), /Stempel 2\/4/);
    assert.match(text(match('A1')), /Nicht auf deiner Route: 105 .*, 113 /);
    assert.ok(match('A1').classList.contains('shown'));
});

test('a suggestion with a stamp just off the route is shown as nearby, with the distance', async () => {
    // 200 m north of stamp 28, running east-west past it
    const s = stampByNumber.get(28);
    const lat = s.lat + 0.0018;
    const pts = Array.from({ length: 31 }, (_, i) => `<trkpt lat="${lat}" lon="${s.lon - 0.003 + i * 0.0002}"/>`).join('');
    await compare(`<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`, 'Daneben.gpx');
    const tour = plan.tours.find(t => t.stamps.includes(28));
    assert.equal(verdict(tour.id), 'in der Nähe');
    assert.match(text(match(tour.id)), new RegExp(`Stempel 0/${tour.stamps.length}`));
    assert.match(text(match(tour.id)), /Nicht auf deiner Route: 28 Gasthaus Steinerne Renne \(20\d m daneben\)/);
});

test('"Auf Karte" toggles the suggestion, "Im Tourenplan" opens it', async () => {
    await compare(loopGpx([129, 130]), 'Kurz.gpx');
    match('A1').querySelector('.match-map').click();
    assert.ok(!match('A1').classList.contains('shown'));
    match('A1').querySelector('.match-map').click();
    assert.ok(match('A1').classList.contains('shown'));

    match('A1').querySelector('.match-tour').click();
    await tick(300);
    assert.equal($('#viewTours').hidden, false);
    assert.equal($('.tour-row.selected')?.dataset.id, 'A1');
});

test('a route without suggestion stamps says so instead of hiding the section', async () => {
    $('#tabCompare').click();
    await tick();
    const far = '<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="53.55" lon="9.99"/><trkpt lat="53.56" lon="10.00"/></trkseg></trk></gpx>';
    await compare(far, 'Hamburg.gpx');
    assert.equal($('#matchSection').hidden, false);
    assert.equal($$('.match').length, 0);
    assert.match(text($('#matchList')), /^Kein Tourenvorschlag in der Nähe/);
});
