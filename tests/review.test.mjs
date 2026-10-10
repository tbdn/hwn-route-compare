// Review hints ("⚠ prüfen"): computed from OpenRouteService tracks (detours, ways back, length),
// notes from tours.json and part tours that are much shorter. Tracks are built for the test,
// so the hints don't depend on the current project tracks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupBrowser, startTourPlan, plan, stampByNumber, $, $$, tick, text, row, setChecked, pickFile
} from './helpers/browser.mjs';

const env = setupBrowser();
await startTourPlan();

const reviewChip = () => $$('.region-chip').find(c => c.dataset.code === 'review');
const chipCount = () => Number(text(reviewChip()).match(/\((\d+)\)/)[1]);
const reviewTexts = () => $$('#tourDetail .review-box li').map(text);
const km = (a, b) => {
    const r = x => x * Math.PI / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// GPX through the given points (straight lines, densified); ORS-made unless a creator is given
function gpx(points, creator = 'HWN Route Compare (OpenRouteService)') {
    let trk = '';
    for (let i = 0; i < points.length - 1; i++) {
        for (let k = 0; k < 40; k++) {
            const a = points[i];
            const b = points[i + 1];
            const t = k / 40;
            trk += `<trkpt lat="${a.lat + (b.lat - a.lat) * t}" lon="${a.lon + (b.lon - a.lon) * t}"><ele>400</ele></trkpt>`;
        }
    }
    const last = points.at(-1);
    trk += `<trkpt lat="${last.lat}" lon="${last.lon}"><ele>400</ele></trkpt>`;
    return `<?xml version="1.0"?><gpx creator="${creator}"><trk><name>Test</name><trkseg>${trk}</trkseg></trk></gpx>`;
}

// An open suggestion without hints and with at least 3 stamps, and its closest pair of consecutive stamps
const target = plan.tours.find(t => !t.single && t.stamps.length >= 3 && !row(t.id).querySelector('.review-tag'));
const stamps = target.stamps.map(n => stampByNumber.get(n));
const pairIndex = stamps.map((s, i) => [i, km(s, stamps[(i + 1) % stamps.length])]).sort((a, b) => a[1] - b[1])[0][0];
const [a, b] = [stamps[pairIndex], stamps[(pairIndex + 1) % stamps.length]];
// Detour point: off to the side by twice the distance, so the leg is about four times the straight line
const detour = { lat: (a.lat + b.lat) / 2 + 2 * (b.lon - a.lon) * 0.62, lon: (a.lon + b.lon) / 2 - 2 * (b.lat - a.lat) / 0.62 };
const loopWithDetour = [...stamps.slice(pairIndex + 1), ...stamps.slice(0, pairIndex + 1)];
loopWithDetour.splice(loopWithDetour.length, 0, detour, loopWithDetour[0]);

async function upload(tourId, name, content) {
    row(tourId).click();
    await tick();
    await pickFile($('#trackFile'), name, content);
}

test('notes from tours.json are shown on their suggestion', async () => {
    for (const tour of plan.tours.filter(t => t.review?.length)) {
        row(tour.id).click();
        await tick();
        for (const note of tour.review) assert.ok(reviewTexts().includes(note), tour.id);
        assert.ok(row(tour.id).querySelector('.review-tag'));
    }
});

test('a detour in an OpenRouteService track is flagged with both stamps and drawn on the map', async () => {
    const before = chipCount();
    await upload(target.id, 'ors.gpx', gpx(loopWithDetour));
    const detourHint = reviewTexts().find(t => t.startsWith('Umweg von'));
    assert.ok(detourHint, reviewTexts().join(' | '));
    assert.match(detourHint, new RegExp(`${a.number} .* nach ${b.number} `));
    assert.ok(row(target.id).querySelector('.review-tag'));
    assert.equal(chipCount(), before + 1);
    assert.ok(env.drawnLines.some(l => l.options?.color === '#C26A00'), 'detour leg highlighted');
});

test('a walked Komoot track with the same detour is not judged', async () => {
    await upload(target.id, 'komoot.gpx', gpx(loopWithDetour, 'komoot'));
    assert.equal($('#tourDetail .review-box'), null);
    assert.equal(row(target.id).querySelector('.review-tag'), null);
});

test('a round that goes back on the same path is flagged', async () => {
    // there and back: first stamp → other stamps → the same way back
    const there = stamps.map(s => ({ lat: s.lat, lon: s.lon }));
    await upload(target.id, 'ors.gpx', gpx([...there, ...there.slice(0, -1).reverse()]));
    assert.ok(reviewTexts().some(t => /% der Strecke führen auf demselben Weg zurück/.test(t)), reviewTexts().join(' | '));
});

test('the review filter shows only flagged rows and, without a selection, an overview', async () => {
    $('#tourClear').click();
    reviewChip().click();
    await tick();
    const visible = $$('.tour-row').filter(r => !r.hidden);
    assert.ok(visible.length > 0);
    assert.ok(visible.every(r => r.querySelector('.review-tag') || $$(`.part-row`).some(p => !p.hidden && p.dataset.id.startsWith(r.dataset.id))));
    assert.ok($$('#tourDetail .review-list li').length >= chipCount());
    $(`#tourDetail [data-unit="${target.id}"]`).click();
    await tick();
    assert.match(text($('#tourDetail h3')), new RegExp(`^Gruppe ${target.id}`));
});

test('a finished suggestion is no longer flagged', async () => {
    const before = chipCount();
    setChecked($('#tourDoneToggle'), true);
    assert.equal($('#tourDetail .review-box'), null);
    assert.equal(chipCount(), before - 1);
    setChecked($('#tourDoneToggle'), false);
});

test('parts that are much shorter than the whole tour are pointed out until the parts are chosen', async () => {
    const files = new Set((await import('node:fs')).readdirSync(new URL('../src/data/tours/', import.meta.url)));
    const candidates = plan.tours.filter(t => t.parts?.length && [t, ...t.parts].every(u => files.has(`${u.id}.gpx`)));
    for (const tour of candidates) {
        row(tour.id).click();
        await tick();
        const hint = reviewTexts().find(t => t.startsWith('In zwei Teilen deutlich kürzer'));
        if (!hint) continue;
        setChecked($('#tourDetail input[name="tourVariant"][value="parts"]'), true);
        await tick();
        row(tour.id).click();
        await tick();
        assert.ok(!reviewTexts().some(t => t.startsWith('In zwei Teilen deutlich kürzer')), tour.id);
        setChecked($('#tourDetail input[name="tourVariant"][value="whole"]'), true);
        await tick();
    }
});
