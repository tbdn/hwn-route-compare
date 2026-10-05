// Routenabgleich: hits that are already collected are marked, and the marks follow progress changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupBrowser, SRC, $, $$, tick, text, loopGpx } from './helpers/browser.mjs';

const env = setupBrowser({ storage: { 'hwn-stamps-collected': '[129]' } });
await import(SRC + 'app.js');
const card = id => $(`#onRouteGrid .stamp[data-stamp-id="${id}"]`);

test('collected hits are marked on their card and in the count', async () => {
    document.dispatchEvent(new CustomEvent('hwn:compare-route', { detail: { gpx: loopGpx([129, 130]), name: 'Runde.gpx' } }));
    await tick(300);
    assert.equal($('#status').textContent, 'Fertig.');
    assert.ok(card('HWN129').classList.contains('got'));
    assert.equal(card('HWN129').querySelector('.got-hint').hidden, false);
    assert.match(text(card('HWN129').querySelector('.stamp-meta')), /schon gestempelt/);
    assert.ok(!card('HWN130').classList.contains('got'));
    assert.equal(card('HWN130').querySelector('.got-hint').hidden, true);
    assert.match($('#resultCount').textContent, / · 1 schon gestempelt$/);
});

test('marks follow changes of the progress', async () => {
    const { setStampsCollected } = await import(SRC + 'components/tourplan.js');
    setStampsCollected([130], true);
    assert.ok(card('HWN130').classList.contains('got'));
    assert.match($('#resultCount').textContent, / · 2 schon gestempelt$/);
    setStampsCollected([129, 130], false);
    assert.ok($$('#onRouteGrid .stamp').every(c => !c.classList.contains('got')));
    assert.doesNotMatch($('#resultCount').textContent, /gestempelt/);
    assert.deepEqual(JSON.parse(env.store['hwn-stamps-collected']), []);
});

test('selecting a collected hit for the extended route still works', async () => {
    const { setStampsCollected } = await import(SRC + 'components/tourplan.js');
    setStampsCollected([129], true);
    const cb = card('HWN129').querySelector('.stamp-checkbox');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    assert.match($('#selectionCount').textContent, /^1 /);
});
