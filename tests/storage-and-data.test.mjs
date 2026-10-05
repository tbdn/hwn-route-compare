// Storage upgrade and project data consistency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupBrowser, plan, stampByNumber } from './helpers/browser.mjs';

setupBrowser();
const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the IndexedDB upgrade to version 2 keeps uploaded tracks and adds own tours', async () => {
    // A browser with database version 1 and an uploaded track
    await new Promise((resolve, reject) => {
        const req = indexedDB.open('hwn-route-compare', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('tour-gpx');
        req.onsuccess = () => {
            const tx = req.result.transaction('tour-gpx', 'readwrite');
            tx.objectStore('tour-gpx').put({ name: 'b7.gpx', gpx: '<gpx/>' }, 'B7');
            tx.oncomplete = () => { req.result.close(); resolve(); };
        };
        req.onerror = reject;
    });

    const tracks = await import('../src/utils/tracks.js');
    assert.deepEqual(await tracks.loadUploadedTracks(), { B7: { name: 'b7.gpx', gpx: '<gpx/>' } });
    const record = { id: 'own-1', name: 'x', gpx: '<gpx/>', stamps: [], status: 'planned', createdAt: '2026-10-05' };
    await tracks.saveOwnTour(record);
    assert.deepEqual(await tracks.loadOwnTours(), [record]);
});

test('every stamp belongs to exactly one suggestion', () => {
    const count = new Map();
    plan.tours.forEach(t => t.stamps.forEach(n => count.set(n, (count.get(n) || 0) + 1)));
    assert.equal(count.size, stampByNumber.size);
    assert.ok([...count.values()].every(c => c === 1));
});

test('stored estimates match the estimate formula (straight line x 1.4, climbs between stamps)', () => {
    const r = x => x * Math.PI / 180;
    const km = (a, b) => 2 * 6371 * Math.asin(Math.sqrt(Math.sin(r(b.lat - a.lat) / 2) ** 2
        + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2));
    const units = plan.tours.filter(t => !t.single).flatMap(t => [t, ...(t.parts || [])]);
    for (const unit of units) {
        const pts = unit.stamps.map(n => stampByNumber.get(n));
        let dist = 0;
        let ascent = 0;
        pts.forEach((s, i) => {
            const next = pts[(i + 1) % pts.length];
            dist += km(s, next);
            ascent += Math.max(0, next.elevation - s.elevation);
        });
        assert.ok(Math.abs(dist * 1.4 - unit.km) <= 0.15, `${unit.id} km`);
        assert.ok(Math.abs(ascent - unit.ascent) <= 2, `${unit.id} ascent`);
    }
});

test('the parts in tours.json are what scripts/suggest-tour-parts.js suggests', () => {
    const out = execFileSync('node', ['scripts/suggest-tour-parts.js'], { cwd: ROOT, encoding: 'utf8' });
    const suggested = [...out.matchAll(/^(\w+): .* → teilen:/gm)].map(m => m[1]).sort();
    const inPlan = plan.tours.filter(t => t.parts?.length).map(t => t.id).sort();
    assert.deepEqual(inPlan, suggested);
    assert.match(out, /^B3: .* → nicht teilen: Brocken/m);
});
