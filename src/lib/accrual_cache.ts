import { MAX_ACCRUAL_DAYS, type AccrualDaySummary } from './accruals';

/**
 * Which days of accruals are still missing, and how to fold new ones in.
 *
 * `/v1/finance/accrual/by-day` answers for one day at a time, so a 31-day window is 31
 * requests against a rate-limited account. A day that has already closed never changes,
 * which makes the caching rule simple and it is the reason the dashboard can afford this
 * method at all: fetch the window once, then ask only for the days still moving.
 *
 * Two rules protect against the failure that motivated this whole layer — a broken
 * integration looking like a quiet period:
 *
 *   - a day that `failed` is never treated as cached, so it is retried;
 *   - the last days are always re-fetched, because Ozon keeps adding accruals to them.
 */

/** Days at the end of the window that are still being written to. */
export const OPEN_DAYS = 2;

export interface AccrualCache {
    days: Record<string, AccrualDaySummary>;
    /** `type_id` to a name; static, so it is kept once fetched. */
    types: Record<string, string>;
    fetchedAt: string | null;
}

export function emptyAccrualCache(): AccrualCache {
    return { days: {}, types: {}, fetchedAt: null };
}

/** Local calendar day as `YYYY-MM-DD`. */
export function toLocalDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/** The window the dashboard asks about, oldest first. */
export function windowDays(now: Date, length = 31): string[] {
    const days: string[] = [];
    const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const count = Math.min(Math.max(length, 1), MAX_ACCRUAL_DAYS);

    for (let index = 0; index < count; index += 1) {
        days.unshift(toLocalDay(cursor));
        cursor.setDate(cursor.getDate() - 1);
    }

    return days;
}

/**
 * Days inside `window` that have to be fetched: everything absent, everything that
 * failed last time, and the trailing open days.
 */
export function daysToFetch(
    cache: AccrualCache,
    window: string[],
    openDays = OPEN_DAYS
): string[] {
    if (window.length === 0) return [];

    const open = new Set(window.slice(-Math.max(openDays, 0)));

    return window.filter((day) => {
        const cached = cache.days[day];
        if (!cached) return true;
        if (cached.status === 'failed') return true;
        return open.has(day);
    });
}

/**
 * Folds freshly fetched days into the cache.
 *
 * A failed day is not stored: keeping it would look like data the next `daysToFetch`
 * call could trust, and there would be no retry.
 */
export function mergeAccrualDays(
    cache: AccrualCache,
    incoming: AccrualDaySummary[],
    types: Record<string, string> = {},
    fetchedAt: string | null = null
): AccrualCache {
    const days = { ...cache.days };

    for (const day of incoming) {
        if (day.status === 'failed') continue;
        days[day.date] = day;
    }

    return {
        days,
        types: Object.keys(types).length > 0 ? { ...cache.types, ...types } : cache.types,
        fetchedAt: fetchedAt ?? cache.fetchedAt
    };
}

/** Drops days outside the window, so an old cache cannot grow forever. */
export function pruneAccrualCache(cache: AccrualCache, window: string[]): AccrualCache {
    const keep = new Set(window);
    const days: Record<string, AccrualDaySummary> = {};

    for (const [day, summary] of Object.entries(cache.days)) {
        if (keep.has(day)) days[day] = summary;
    }

    return { ...cache, days };
}

/** The cached days inside a window, oldest first. */
export function cachedWindow(cache: AccrualCache, window: string[]): AccrualDaySummary[] {
    return window
        .map((day) => cache.days[day])
        .filter((day): day is AccrualDaySummary => Boolean(day));
}
