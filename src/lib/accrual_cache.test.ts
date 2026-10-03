import { describe, expect, it } from 'vitest';
import {
    cachedWindow,
    daysToFetch,
    emptyAccrualCache,
    mergeAccrualDays,
    pruneAccrualCache,
    toLocalDay,
    windowDays,
    type AccrualCache
} from './accrual_cache';
import type { AccrualDaySummary } from './accruals';

function day(date: string, over: Partial<AccrualDaySummary> = {}): AccrualDaySummary {
    return {
        date,
        status: 'ok',
        net: 100,
        gross: 200,
        byType: {},
        byCategory: {},
        cabinetByType: {},
        counts: { total: 1, withPosting: 1, cabinet: 0 },
        ...over
    };
}

function cacheWith(days: AccrualDaySummary[], types: Record<string, string> = {}): AccrualCache {
    return { days: Object.fromEntries(days.map((entry) => [entry.date, entry])), types, fetchedAt: null };
}

describe('toLocalDay', () => {
    it('formats the local calendar day', () => {
        expect(toLocalDay(new Date(2026, 8, 16, 23, 59))).toBe('2026-09-16');
        expect(toLocalDay(new Date(2026, 0, 5))).toBe('2026-01-05');
    });
});

describe('windowDays', () => {
    it('lists the trailing days, oldest first', () => {
        expect(windowDays(new Date(2026, 8, 16), 3)).toEqual([
            '2026-09-14',
            '2026-09-15',
            '2026-09-16'
        ]);
    });

    it('crosses a month boundary', () => {
        expect(windowDays(new Date(2026, 8, 2), 3)).toEqual([
            '2026-08-31',
            '2026-09-01',
            '2026-09-02'
        ]);
    });

    it('caps the length so one visit cannot walk an unbounded history', () => {
        expect(windowDays(new Date(2026, 8, 16), 5000)).toHaveLength(62);
    });

    it('never returns an empty window for a length below one', () => {
        expect(windowDays(new Date(2026, 8, 16), 0)).toEqual(['2026-09-16']);
    });
});

describe('daysToFetch', () => {
    const window = ['2026-09-14', '2026-09-15', '2026-09-16'];

    it('asks for everything on a cold cache', () => {
        expect(daysToFetch(emptyAccrualCache(), window)).toEqual(window);
    });

    it('skips closed days already cached', () => {
        const cache = cacheWith([day('2026-09-14'), day('2026-09-15'), day('2026-09-16')]);

        // Only the two trailing days are re-read.
        expect(daysToFetch(cache, window)).toEqual(['2026-09-15', '2026-09-16']);
    });

    it('retries a day that failed instead of treating it as data', () => {
        const cache = cacheWith([
            day('2026-09-14', { status: 'failed', error: 'obsolete method' }),
            day('2026-09-15'),
            day('2026-09-16')
        ]);

        expect(daysToFetch(cache, window)).toContain('2026-09-14');
    });

    it('treats a genuinely empty day as cached', () => {
        const cache = cacheWith([
            day('2026-09-14', { status: 'empty', net: 0 }),
            day('2026-09-15'),
            day('2026-09-16')
        ]);

        // An empty day is a fact, not a gap, so it is not refetched forever.
        expect(daysToFetch(cache, window)).not.toContain('2026-09-14');
    });

    it('covers a longer window by fetching only the new tail', () => {
        const shorter = windowDays(new Date(2026, 8, 16), 3);
        const cache = cacheWith(shorter.map((date) => day(date)));
        const longer = windowDays(new Date(2026, 8, 18), 5);

        // The three cached days are closed and stay untouched; only the two new days
        // are requested. Days are independent, so a longer window cannot open a hole
        // the way merging partial postings could.
        expect(daysToFetch(cache, longer)).toEqual(['2026-09-17', '2026-09-18']);
    });

    it('is empty for an empty window', () => {
        expect(daysToFetch(emptyAccrualCache(), [])).toEqual([]);
    });
});

describe('mergeAccrualDays', () => {
    it('stores fetched days and the catalogue', () => {
        const merged = mergeAccrualDays(
            emptyAccrualCache(),
            [day('2026-09-15')],
            { 301: 'Логистика' },
            '2026-09-16T10:00:00Z'
        );

        expect(merged.days['2026-09-15'].net).toBe(100);
        expect(merged.types).toEqual({ 301: 'Логистика' });
        expect(merged.fetchedAt).toBe('2026-09-16T10:00:00Z');
    });

    it('refuses to store a failed day, so it gets retried', () => {
        const merged = mergeAccrualDays(emptyAccrualCache(), [
            day('2026-09-14', { status: 'failed', error: 'boom' })
        ]);

        expect(merged.days['2026-09-14']).toBeUndefined();
    });

    it('overwrites a day that was re-fetched, because accruals keep accruing', () => {
        const before = cacheWith([day('2026-09-16', { net: 100 })]);
        const after = mergeAccrualDays(before, [day('2026-09-16', { net: 250 })]);

        expect(after.days['2026-09-16'].net).toBe(250);
    });

    it('keeps the existing catalogue when the response carries none', () => {
        const before = cacheWith([], { 301: 'Логистика' });
        const after = mergeAccrualDays(before, [day('2026-09-15')]);

        expect(after.types).toEqual({ 301: 'Логистика' });
    });

    it('does not mutate the cache it was given', () => {
        const before = cacheWith([day('2026-09-15', { net: 1 })]);
        mergeAccrualDays(before, [day('2026-09-15', { net: 2 })]);

        expect(before.days['2026-09-15'].net).toBe(1);
    });
});

describe('pruneAccrualCache', () => {
    it('drops days outside the window', () => {
        const cache = cacheWith([
            day('2026-08-01'),
            day('2026-09-15'),
            day('2026-09-16')
        ]);
        const pruned = pruneAccrualCache(cache, ['2026-09-15', '2026-09-16']);

        expect(Object.keys(pruned.days).sort()).toEqual(['2026-09-15', '2026-09-16']);
    });

    it('keeps the catalogue, which is not tied to the window', () => {
        const cache = cacheWith([day('2026-08-01')], { 301: 'Логистика' });
        const pruned = pruneAccrualCache(cache, []);

        expect(pruned.types).toEqual({ 301: 'Логистика' });
        expect(pruned.days).toEqual({});
    });
});

describe('cachedWindow', () => {
    it('returns the cached days in window order, skipping the missing ones', () => {
        const cache = cacheWith([day('2026-09-14'), day('2026-09-16')]);

        expect(
            cachedWindow(cache, ['2026-09-14', '2026-09-15', '2026-09-16']).map((d) => d.date)
        ).toEqual(['2026-09-14', '2026-09-16']);
    });

    it('is empty when nothing is cached', () => {
        expect(cachedWindow(emptyAccrualCache(), ['2026-09-16'])).toEqual([]);
    });
});
