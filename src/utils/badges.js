// Badges of the Harzer Wandernadel: performance levels (number of stamps, the Steiger with required stamps)
// and themed collections (Grenzweg, Hexenstieg, ...). Data in src/data/badges.json, logic here (no DOM).

/**
 * Load the badge definitions
 * @returns {Promise<Object>} - {source, checkedAt, levels: [...], themes: [...]}
 */
export async function loadBadges() {
    const response = await fetch('./data/badges.json');
    if (!response.ok) {
        throw new Error('Konnte Abzeichen nicht laden');
    }
    return response.json();
}

/**
 * Date a condition was met: when `needed` stamps of the pool and all required stamps were collected.
 * Only known when every collected stamp of the pool has a date.
 * @returns {string|null} - 'YYYY-MM-DD'
 */
function reachedSince(pool, needed, required, collected, dateOf) {
    const got = pool.filter(n => collected.has(n));
    const dates = got.map(dateOf);
    if (got.length < needed || dates.some(d => !d)) return null;
    const sorted = [...dates].sort();
    const requiredDates = required.map(dateOf);
    return [sorted[needed - 1], ...requiredDates].sort().at(-1);
}

/**
 * Progress towards every badge
 * @param {Object} badges - data from badges.json
 * @param {Set<number>} collected - collected stamp numbers
 * @param {Function} dateOf - (number) => 'YYYY-MM-DD' | null
 * @param {Array<number>} allNumbers - every stamp number (the pool for the levels)
 * @returns {{levels: Array, next: Object|null, themes: Array}}
 */
export function badgeProgress(badges, collected, dateOf, allNumbers) {
    const levels = (badges?.levels || []).map(level => {
        const required = level.required || [];
        const missingRequired = required.filter(n => !collected.has(n));
        const remaining = Math.max(0, level.stamps - collected.size);
        const reached = !remaining && !missingRequired.length;
        return {
            ...level,
            reached,
            remaining,
            missingRequired,
            since: reached ? reachedSince(allNumbers, level.stamps, required, collected, dateOf) : null
        };
    });
    const themes = (badges?.themes || []).map(theme => {
        const needed = theme.needed ?? theme.stamps.length;
        const required = theme.required || [];
        const got = theme.stamps.filter(n => collected.has(n)).length;
        const missingRequired = required.filter(n => !collected.has(n));
        const complete = got >= needed && !missingRequired.length;
        return {
            ...theme,
            needed,
            got,
            missingRequired,
            complete,
            open: theme.stamps.filter(n => !collected.has(n)),
            since: complete ? reachedSince(theme.stamps, needed, required, collected, dateOf) : null
        };
    });
    return { levels, next: levels.find(l => !l.reached) || null, themes };
}

/**
 * What is missing for a level, e.g. "noch 7 Stempel bis Harzer Wanderkönig/-in"
 * or "noch 3 Pflichtstempel bis Harzer Steiger: 37, 39, 60"
 */
export function remainingText(level) {
    if (!level) return '';
    const required = level.missingRequired.length;
    const parts = [
        level.remaining && `${level.remaining} Stempel`,
        required && `${required} Pflichtstempel`
    ].filter(Boolean).join(' und ');
    const list = required && required <= 5 ? `: ${level.missingRequired.join(', ')}` : '';
    return `noch ${parts} bis ${level.name}${list}`;
}
