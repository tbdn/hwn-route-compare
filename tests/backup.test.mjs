// Backing up the progress (plan "Stempel" step 2): the shared bar on "Meine Stempel" and in the Tourenplan,
// the reminder states, persistent storage, and a complete export before the Tourenplan was ever opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupBrowser, startTourPlan, stamps, tourById, SRC, $, $$, tick, text, setChecked, importProgressFile, loopGpx, row
} from './helpers/browser.mjs';

const env = setupBrowser();
const persistCalls = [];
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { persist: async () => { persistCalls.push(1); return true; }, persisted: async () => false } }
});

// Browser data from earlier visits: an uploaded track and an own tour (IndexedDB)
const tracks = await import(SRC + 'utils/tracks.js');
await tracks.saveUploadedTrack('A1', { name: 'A1-komoot.gpx', gpx: loopGpx(tourById('A1').stamps, 'A1 Komoot'), uploadedAt: '2026-09-01T10:00:00Z' });
await tracks.saveOwnTour({ id: 'own-1', name: 'Meine Runde', gpx: loopGpx([129, 130]), fileName: 'runde.gpx', stamps: [129, 130], status: 'planned', createdAt: '2026-09-02T10:00:00Z' });

const pass = await import(SRC + 'components/stamppass.js');
await pass.showStampPass(stamps);
await tick();

const hint = () => ({ shown: !$('#backupHint').hidden, urgent: $('#backupHint').classList.contains('urgent'), text: text($('#backupHintText')), now: !$('#backupNow').hidden });
const toggle = n => setChecked($(`.pass-stamp[data-stamp="${n}"] .pass-done`), !$(`.pass-stamp[data-stamp="${n}"]`).classList.contains('got'));
const lastExport = () => JSON.parse(env.downloads.at(-1));
const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();

test('no reminder while nothing is collected', () => {
    assert.equal(hint().shown, false);
});

test('the first stamp asks for persistent storage and shows an urgent reminder', async () => {
    toggle(1);
    await tick();
    assert.deepEqual(hint(), { shown: true, urgent: true, text: 'Dein Stand (1 Stempel) ist nur in diesem Browser gespeichert. Der Browser hält den Speicher dauerhaft.', now: true });
    toggle(2);
    await tick();
    assert.equal(persistCalls.length, 1, 'asked only once');
});

test('the export from "Meine Stempel" is complete before the Tourenplan was opened', () => {
    $('#backupNow').click();
    const data = lastExport();
    assert.deepEqual(data.stamps, [1, 2]);
    assert.deepEqual(Object.keys(data.tracks), ['A1']);
    assert.deepEqual(data.ownTours.map(t => t.id), ['own-1']);
    assert.equal($('#uploadsClear').textContent, 'Browser-Tracks löschen (1)');
});

test('after a backup only a short note is left', () => {
    assert.equal(JSON.parse(env.store['hwn-last-backup']).stamps, 2);
    assert.equal(env.store['hwn-changes-since-backup'], '0');
    const h = hint();
    assert.equal(h.urgent, false);
    assert.match(h.text, /^Gesichert am \d{2}\.\d{2}\.\d{4}\./);
});

test('changes since the backup are counted, ten of them make it urgent', () => {
    toggle(3);
    assert.equal(hint().text.split('.')[0], 'Letzte Sicherung heute, seitdem 1 Änderung');
    assert.equal(hint().urgent, false);
    for (let n = 4; n <= 12; n++) toggle(n);
    assert.match(hint().text, /seitdem 10 Änderungen/);
    assert.equal(hint().urgent, true);
});

test('an old backup is urgent after a single change', () => {
    env.store['hwn-last-backup'] = JSON.stringify({ at: daysAgo(20), stamps: 5 });
    env.store['hwn-changes-since-backup'] = '0';
    toggle(13);
    assert.equal(hint().text.split('.')[0], 'Letzte Sicherung vor 20 Tagen, seitdem 1 Änderung');
    assert.equal(hint().urgent, true);
});

test('"Später erinnern" quiets the reminder for a week', () => {
    $('#backupSnooze').click();
    assert.equal(hint().urgent, false);
    assert.equal(hint().now, false);
    assert.ok(Date.parse(env.store['hwn-backup-snooze']) > Date.now() + 6 * 86400000);
    toggle(14);
    assert.equal(hint().urgent, false, 'still quiet after another change');
});

test('an import counts as a backup and updates "Meine Stempel" without the Tourenplan', async () => {
    await importProgressFile(JSON.stringify({ format: 'hwn-tourenplan-progress', version: 3, stamps: [7, 8] }));
    assert.match($('#progressStatus').textContent, /^Importiert:/);
    assert.equal(env.store['hwn-changes-since-backup'], '0');
    assert.equal(env.store['hwn-backup-snooze'], undefined);
    assert.equal(hint().urgent, false);
    assert.deepEqual($$('.pass-stamp.got').map(t => Number(t.dataset.stamp)), [7, 8]);
});

test('the Tourenplan opened afterwards shows the own tour and the uploaded track', async () => {
    await startTourPlan();
    assert.match(text($('.own-card .tour-row')), /Meine Runde/);
    row('A1').click();
    await tick();
    assert.match(text($('#tourDetail .track-source')), /^Geplanter Track/);
    assert.equal($('#uploadsClear').hidden, false);
});
