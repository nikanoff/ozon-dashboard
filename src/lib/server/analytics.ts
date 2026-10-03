import { callOzonWithRetry, type Credentials } from './ozon';
import { isTruncated, toTurnoverRows, type TurnoverRow } from '$lib/turnover';

/**
 * Ozon's turnover report.
 *
 * Hard-limited by Ozon to **one request per minute**, and paginated. A page walk would
 * therefore take minutes, so exactly one page is requested with the largest limit the
 * method accepts and the result reports whether more rows exist. Showing a truncated list
 * and saying so beats a silent partial answer or a multi-minute wait.
 */

/** Largest page the method is documented to accept. */
const TURNOVER_LIMIT = 1000;

export interface TurnoverResult {
    rows: TurnoverRow[];
    /** True when Ozon holds more rows than were returned. */
    truncated: boolean;
    /** Set when the method refused or failed, so the UI can hide rather than show zeros. */
    error?: string;
}

export async function collectTurnover(
    credentials: Credentials,
    signal?: AbortSignal
): Promise<TurnoverResult> {
    try {
        const raw = await callOzonWithRetry<unknown>(
            '/v1/analytics/turnover/stocks',
            { limit: TURNOVER_LIMIT, offset: 0 },
            credentials,
            signal
        );

        return { rows: toTurnoverRows(raw), truncated: isTruncated(raw) };
    } catch (error) {
        // An enrichment must never break the page: report the failure and let the
        // section stay hidden.
        return {
            rows: [],
            truncated: false,
            error: error instanceof Error ? error.message : 'Оборачиваемость недоступна'
        };
    }
}
