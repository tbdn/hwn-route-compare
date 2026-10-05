// Badges (plan "Stempel" step 5): levels from badges.json, the Steiger with its required stamps,
// themed collections, the "seit" date, the ladder on "Meine Stempel" and the next level in the Tourenplan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupBrowser, startTourPlan, stamps, readJSON, SRC, $, $$, text, stats } from './helpers/browser.mjs';

const numbers = stamps.map(s => s.number).sort((a, b) => a - b);
const first = n => numbers.slice(0, n);
// 50 stamps collected, with dates one day apart from 2026-01-01
setupBrowser({ storage: {
    'hwn-stamps-collected': JSON.stringify(first(50)),
    'hwn-stamp-dates': JSON.stringify(Object.fromEntries(first(50).map((n, i) => [n, `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`])))
} });
const badges = readJSON('data/badges.json');
const { badgeProgress, remainingText } = await import(SRC + 'utils/badges.js');
const progress = (collected, dateOf = () => null) => badgeProgress(badges, new Set(collected), dateOf, numbers);
const reachedIds = p => p.levels.filter(l => l.reached).map(l => l.id);
const theme = (p, id) => p.themes.find(t => t.id === id);

test('badges.json is consistent with the stamps', () => {
    const known = new Set(numbers);
    const thresholds = badges.levels.map(l => l.stamps);
    assert.deepEqual(thresholds, [...thresholds].sort((a, b) => a - b), 'levels ascending');
    assert.equal(thresholds.at(-1), numbers.length, 'Wanderkaiser = all stamps');
    [...badges.levels.flatMap(l => l.required || []), ...badges.themes.flatMap(t => [...t.stamps, ...(t.required || [])])]
        .forEach(n => assert.ok(known.has(n), `unknown stamp ${n}`));
    badges.themes.forEach(t => {
        assert.equal(new Set(t.stamps).size, t.stamps.length, `${t.id}: no duplicates`);
        assert.ok((t.needed ?? t.stamps.length) <= t.stamps.length, t.id);
        (t.required || []).forEach(n => assert.ok(t.stamps.includes(n), `${t.id}: required ${n} in the list`));
    });
});

test('levels by number of stamps', () => {
    assert.deepEqual(reachedIds(progress([])), []);
    assert.equal(remainingText(progress([]).next), 'noch 8 Stempel bis Harzer Wandernadel Bronze');
    assert.deepEqual(reachedIds(progress(first(8))), ['bronze']);
    assert.equal(progress(first(10)).next.id, 'prinz');
    assert.deepEqual(reachedIds(progress(first(11))), ['bronze', 'prinz']);
    assert.equal(remainingText(progress(first(49)).next), 'noch 1 Stempel bis Harzer Wanderkönig/-in');
    assert.deepEqual(reachedIds(progress(first(50))), ['bronze', 'prinz', 'silber', 'gold', 'koenig']);
    assert.equal(progress(numbers).next, null);
    assert.equal(reachedIds(progress(numbers)).length, badges.levels.length);
});

test('the Steiger needs 111 stamps and all of its required stamps', () => {
    const steiger = badges.levels.find(l => l.id === 'steiger');
    const without = numbers.filter(n => !steiger.required.includes(n)).slice(0, 120);
    const p = progress(without);
    assert.ok(reachedIds(p).includes('kaiserrucksack'));
    assert.ok(!reachedIds(p).includes('steiger'));
    assert.equal(p.next.id, 'steiger');
    assert.match(remainingText(p.next), new RegExp(`^noch ${steiger.required.length} Pflichtstempel bis Harzer Steiger$`));

    const almost = [...without, ...steiger.required.slice(3)];
    assert.equal(remainingText(progress(almost).next), `noch 3 Pflichtstempel bis Harzer Steiger: ${steiger.required.slice(0, 3).join(', ')}`);
    assert.ok(reachedIds(progress([...without, ...steiger.required])).includes('steiger'));
});

test('themed collections: all stamps, or some plus required ones (Hexenstieg)', () => {
    const grenzweg = badges.themes.find(t => t.id === 'grenzweg');
    assert.equal(theme(progress(grenzweg.stamps.slice(1)), 'grenzweg').complete, false);
    assert.equal(theme(progress(grenzweg.stamps), 'grenzweg').complete, true);

    const hexen = badges.themes.find(t => t.id === 'hexenstieg');
    const others = hexen.stamps.filter(n => !hexen.required.includes(n));
    const eleven = theme(progress(others.slice(0, 11)), 'hexenstieg');
    assert.equal(eleven.complete, false, '11 stamps but not 69 and 140');
    assert.deepEqual(eleven.missingRequired, [69, 140]);
    assert.equal(theme(progress([...others.slice(0, 9), 69, 140]), 'hexenstieg').complete, true);
});

test('"seit" is the date the condition was met, only with complete dates', () => {
    const dateOf = n => `2026-0${n <= 8 ? 1 : 2}-${String(n).padStart(2, '0')}`;
    const p = progress(first(10), dateOf);
    assert.equal(p.levels[0].since, '2026-01-08', 'bronze with the 8th stamp');
    assert.equal(progress(first(10), n => n === 3 ? null : dateOf(n)).levels[0].since, null);
});

test('"Meine Stempel" shows the ladder, the next level and the collections', async () => {
    const pass = await import(SRC + 'components/stamppass.js');
    await pass.showStampPass(stamps);
    assert.equal($('#passBadges').hidden, false);
    assert.equal(text($('.badge-next')), 'noch 50 Stempel bis Harzer Kaiserrucksack');
    assert.equal($$('.badge-level.reached').length, 5);
    assert.equal(text($('.badge-level.next .badge-count')), '100');
    assert.match(text($$('.badge-level.reached')[0].querySelector('.badge-detail')), /^seit \d{2}\.01\.2026$/);
    assert.equal($$('.pass-progress .tick.passed').length, 5);

    const nph = badges.themes.find(t => t.id === 'nationalpark');
    const got = nph.stamps.filter(n => n <= 50).length;
    const row = $$('.badge-theme').find(r => r.textContent.includes('Nationalpark Harz'));
    assert.match(text(row.querySelector('.badge-theme-count')), new RegExp(`^${got} / ${nph.stamps.length}`));
});

test('a collection filters the grid', () => {
    const grenzweg = badges.themes.find(t => t.id === 'grenzweg');
    $('.badge-theme-name[data-theme="grenzweg"]').click();
    assert.deepEqual($$('.pass-stamp').filter(t => !t.hidden).map(t => Number(t.dataset.stamp)), grenzweg.stamps);
    $('.badge-filter[data-theme="steiger"]').click();
    assert.deepEqual($$('.pass-stamp').filter(t => !t.hidden).map(t => Number(t.dataset.stamp)), badges.levels.find(l => l.id === 'steiger').required);
});

test('the Tourenplan names the next level', async () => {
    await startTourPlan();
    assert.equal(stats()['Stempel gesammelt'], '50');
    assert.equal(text($('.stat-next')), 'noch 50 bis Kaiserrucksack');
});
