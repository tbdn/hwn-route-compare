// Routenabgleich (plan step 4): a compared route and the extended route through selected stamps
// can be saved as own tours. All ORS requests use the GeoJSON endpoint and draw plain point arrays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupBrowser, SRC, $, $$, tick, text, setChecked, isRenderedChecked, loopGpx } from './helpers/browser.mjs';

const env = setupBrowser({ storage: { 'hwn-ors-api-key': 'test', 'hwn-routing-cache': '{"old":{}}' } });
await import(SRC + 'app.js');
const formStamps = () => $$('.own-stamp').map(cb => `${cb.dataset.stamp}${isRenderedChecked(cb) ? '✓' : ''}`);
let nearbyCard;

test('a route handed over from the Tourenplan is compared', async () => {
    $('#thresh').value = '6000';
    document.dispatchEvent(new CustomEvent('hwn:compare-route', { detail: { gpx: loopGpx([129, 130]), name: 'Meine Komoot-Runde.gpx' } }));
    await tick(300);
    assert.equal($('#status').textContent, 'Fertig.');
    assert.deepEqual($$('#onRouteGrid .stamp').map(c => c.dataset.stampId), ['HWN129', 'HWN130']);
    assert.ok($$('#nearbyGrid .stamp').length > 0);
    nearbyCard = $('#nearbyGrid .stamp');
});

test('a detour route uses the GeoJSON endpoint and draws [lat, lon] points', async () => {
    nearbyCard.querySelector('.calc-route-btn').click();
    await tick();
    assert.match(env.ors.calls.at(-1).url, /\/geojson$/);
    assert.match(text(nearbyCard.querySelector('.routing-result')), /^🥾 4.3 km ⏱ 1h · ↑\d+m$/);
    const line = env.drawnLines.at(-1).points;
    assert.ok(Array.isArray(line[0]) && line[0].length === 2 && Math.abs(line[0][0]) <= 90);
});

test('the routing cache moved to v2 and the old encoded entries are gone', () => {
    assert.ok(env.store['hwn-routing-cache-v2']);
    assert.equal(env.store['hwn-routing-cache'], undefined);
});

test('the compared route opens the own tour form with on-route and selected stamps', async () => {
    setChecked(nearbyCard.querySelector('.stamp-checkbox'), true);
    $('#saveOwnTour').click();
    await tick(400);

    assert.equal($('#viewTours').hidden, false);
    assert.equal(text($('#tourDetail h3')), 'Eigene Tour anlegen');
    assert.equal($('#ownName').value, 'Meine Komoot-Runde');
    const selected = Number(nearbyCard.dataset.stampId.replace('HWN', ''));
    assert.deepEqual(formStamps(), ['129✓', '130✓', `${selected}✓`]);

    $('#ownForm').dispatchEvent(new Event('submit'));
    await tick();
    assert.match(text($('#tourDetail h3')), /^Meine Komoot-Runde geplant/);
});

test('the extended route can be saved once it is calculated', async () => {
    $('#tabCompare').click();
    await tick();
    setChecked(nearbyCard.querySelector('.stamp-checkbox'), true);
    assert.equal($('#saveExtendedOwn').disabled, true);

    $('#addToRoute').click();
    await tick(200);
    assert.equal($('#routeStatus').textContent, 'Route berechnet');
    assert.equal($('#saveExtendedOwn').disabled, false);

    $('#showOnMap').click();
    assert.ok(Array.isArray(env.drawnLines.at(-1).points[0]), 'extended route drawn as points');

    $('#addToRoute').click();
    await tick(200);
    $('#saveExtendedOwn').click();
    await tick(400);
    assert.equal($('#ownName').value, 'Meine Komoot-Runde + 1 Stempel');
    assert.ok(formStamps().includes(`${nearbyCard.dataset.stampId.replace('HWN', '')}✓`));

    $('#ownForm').dispatchEvent(new Event('submit'));
    await tick();
    assert.match(text($('#tourDetail .track-source')), /^Eigene Tour, Weg von OpenRouteService \(ungeprüft\)/);
    assert.ok(env.ors.calls.every(c => c.url.endsWith('/geojson')));
});
