// "Auf Wanderwege legen": the stamp loop is routed via OpenRouteService (GeoJSON endpoint)
// and stored as an uploaded track; it is a planned route, never progress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupBrowser, startTourPlan, tourById, $, tick, text, row } from './helpers/browser.mjs';

const env = setupBrowser();
await startTourPlan();
const { setApiKey } = await import('../src/utils/routing.js');
const { loadUploadedTracks } = await import('../src/utils/tracks.js');
const message = () => text($('#tourDetail .track-box .track-ok, #tourDetail .track-box .track-warning'));

test('without an API key the user is told where to enter it', async () => {
    row('A2').click();
    await tick();
    $('#trackRoute').click();
    await tick();
    assert.match(message(), /Hinterlege ihn im Tab Routenabgleich/);
});

test('routes the closed stamp loop with elevation and stores it as a planned track', async () => {
    setApiKey('test');
    row('A2').click();
    await tick();
    $('#trackRoute').click();
    await tick(150);

    const { url, body } = env.ors.calls.at(-1);
    assert.match(url, /\/geojson$/);
    assert.equal(body.elevation, true);
    assert.equal(body.coordinates.length, tourById('A2').stamps.length + 1);
    assert.deepEqual(body.coordinates[0], body.coordinates.at(-1));

    assert.match(message(), /^Route auf Wanderwegen gespeichert \(geplant\)/);
    assert.match(text($('#tourDetail .track-source')), /^Routenvorschlag \(OpenRouteService, ungeprüft\): OpenRouteService – Tour A2 · im Browser hinterlegt/);
    assert.equal(text($('#trackRoute')), 'Neu auf Wanderwege legen');
    assert.deepEqual(Object.keys(await loadUploadedTracks()), ['A2']);
    assert.equal(env.store['hwn-stamps-collected'], '[]', 'a track never changes progress');
});

test('shows the reason when ORS finds no route', async () => {
    env.ors.mode = '404';
    row('A2').click();
    await tick();
    $('#trackRoute').click();
    await tick(150);
    assert.equal(message(), 'Route nicht berechnet: Keine Route gefunden: Could not find routable point within a radius of 350.0 meters');
});

test('single stamps cannot be routed', async () => {
    row('G1').click();
    await tick();
    assert.equal($('#trackRoute'), null);
});

test('all uploaded tracks can be deleted at once; the project files apply again', async () => {
    assert.equal($('#uploadsClear').hidden, false);
    assert.equal(text($('#uploadsClear')), 'Browser-Tracks löschen (1)');

    $('#uploadsClear').click();
    assert.equal($('#uploadsConfirm').hidden, false);
    assert.match(text($('#uploadsConfirmText')), /^1 im Browser hinterlegten Track löschen\? Projektdateien, eigene Touren, Komoot-Links und Fortschritt bleiben\./);
    $('#uploadsClearNo').click();
    assert.equal($('#uploadsConfirm').hidden, true);
    assert.deepEqual(Object.keys(await loadUploadedTracks()), ['A2']);

    $('#uploadsClear').click();
    $('#uploadsClearYes').click();
    await tick(150);
    assert.deepEqual(await loadUploadedTracks(), {});
    assert.equal($('#progressStatus').textContent, '1 Browser-Track gelöscht. Es gelten wieder die Projektdateien.');
    assert.equal($('#uploadsClear').hidden, true);

    row('A2').click();
    await tick();
    assert.match(text($('#tourDetail .track-source')), /· Projektdatei$/);
});
