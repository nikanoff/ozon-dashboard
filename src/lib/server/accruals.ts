import { callOzonWithRetry, mapWithConcurrency, type Credentials } from './ozon';
import {
    summariseDay,
    toAccrual,
    toTypeCatalogue,
    POSTING_DETAIL_DAYS,
    type Accrual,
    type AccrualDaySummary
} from '$lib/accruals';

/**
 * The network half of the financial layer: walks `/v1/finance/accrual/by-day`.
 *
 * The method takes a single day per call, so a 31-day window is 31 requests — days are
 * fetched in parallel and each day's cursor is followed to the end. Parsing and folding
 * live in `$lib/accruals.ts` and are unit-tested there.
 */

/** Largest page the method accepts in practice; also a runaway guard. */
const PAGES_PER_DAY = 200;
/** Days fetched in parallel. Days are independent, but Ozon throttles per account. */
const DAY_CONCURRENCY = 4;

interface AccrualByDayResponse {
    accruals?: unknown[];
    last_id?: string;
}

/** Walks the cursor for a single day. */
async function collectDay(
    credentials: Credentials,
    date: string,
    signal?: AbortSignal
): Promise<Accrual[]> {
    const accruals: Accrual[] = [];
    let lastId = '';

    for (let page = 0; page < PAGES_PER_DAY; page += 1) {
        const body: Record<string, unknown> = { date };
        if (lastId) body.last_id = lastId;

        const response = await callOzonWithRetry<AccrualByDayResponse>(
            '/v1/finance/accrual/by-day',
            body,
            credentials,
            signal
        );

        const rows = response.accruals ?? [];
        for (const row of rows) {
            const accrual = toAccrual(row);
            if (accrual) accruals.push(accrual);
        }

        const next = response.last_id ?? '';
        // An empty cursor, an empty page, or a cursor that repeats all mean "done".
        if (!next || rows.length === 0 || next === lastId) break;
        lastId = next;
    }

    return accruals;
}

/**
 * Fetches an explicit list of days, oldest first.
 *
 * Taking dates rather than a range is what makes caching worth anything: a closed day
 * never changes, so the browser asks only for the days it is missing instead of walking
 * the whole window on every visit.
 *
 * A day that fails is reported as `failed`, not `empty`. Confusing the two is exactly
 * how a switched-off method looks like a quiet sales period: one seller spent two weeks
 * computing profit from data that had stopped arriving.
 */
export async function collectAccrualDates(
    credentials: Credentials,
    dates: string[],
    signal?: AbortSignal
): Promise<AccrualDaySummary[]> {
    const detailFrom = dates.length - POSTING_DETAIL_DAYS;

    return mapWithConcurrency(dates, DAY_CONCURRENCY, async (date, index) => {
        try {
            const accruals = await collectDay(credentials, date, signal);
            return summariseDay(date, accruals, index >= detailFrom);
        } catch (error) {
            return {
                date,
                status: 'failed' as const,
                error: error instanceof Error ? error.message : 'Не удалось получить начисления',
                net: 0,
                gross: 0,
                byType: {},
                byCategory: {},
                cabinetByType: {},
                counts: { total: 0, withPosting: 0, cabinet: 0 }
            };
        }
    });
}

/**
 * The accrual type catalogue: `type_id` to a human name.
 *
 * Static, so a caller may cache it indefinitely. A failure here is not fatal — the
 * dashboard falls back to showing raw type ids rather than blocking the screen.
 */
export async function collectAccrualTypes(
    credentials: Credentials,
    signal?: AbortSignal
): Promise<Record<string, string>> {
    try {
        const raw = await callOzonWithRetry<unknown>(
            '/v1/finance/accrual/types',
            {},
            credentials,
            signal
        );
        return toTypeCatalogue(raw);
    } catch {
        return {};
    }
}
