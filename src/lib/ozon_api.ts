import { get } from 'svelte/store';
import { ozonKeys } from './stores/ozon_keys';
import type { DashboardPayload, StocksPayload } from './ozon_types';
import type { AccrualDaySummary } from './accruals';
import type { MonthFinance } from './realization';

export interface OzonApiError extends Error {
    status: number;
    /** Raw response body from the endpoint, if available. */
    payload: unknown;
}

export interface EconomicsPayload {
    days: AccrualDaySummary[];
    /** `type_id` to a name; empty when the caller already holds the catalogue. */
    types: Record<string, string>;
    fetchedAt: string;
}

function makeError(response: Response, payload: unknown): OzonApiError {
    const message =
        (payload as { message?: string } | null)?.message ||
        `Ozon API error: ${response.status} ${response.statusText}`;

    const error = new Error(message) as OzonApiError;
    error.status = response.status;
    error.payload = payload;
    return error;
}

/**
 * The pages no longer walk Ozon's cursors themselves: each endpoint returns the
 * finished payload, so this is the only request the browser makes per page.
 */
async function callBundle<T>(
    path: string,
    signal?: AbortSignal,
    body: unknown = {}
): Promise<T> {
    const keys = get(ozonKeys);

    const response = await fetch(path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Ozon-Client-Id': keys.clientId,
            'X-Ozon-Api-Key': keys.apiKey
        },
        body: JSON.stringify(body),
        signal
    });

    let payload: unknown = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        throw makeError(response, payload);
    }

    return payload as T;
}

/**
 * Orders, statistics and product images for the dashboard.
 *
 * Pass `since` to re-read only the recent tail of the history; the caller merges
 * that into the payload it already holds. `extra` states the period cards' previous
 * calendar month: the server adds it as a third range only when the other two do not
 * already hold it, and uses its start as the returns window either way.
 */
export function getDashboardData(
    signal?: AbortSignal,
    since?: string,
    windowFrom?: string,
    windowTo?: string,
    extra?: { from: string; to: string }
) {
    return callBundle<DashboardPayload>('/api/dashboard', signal, {
        ...(since ? { since } : {}),
        ...(windowFrom ? { windowFrom } : {}),
        ...(windowTo ? { windowTo } : {}),
        ...(extra ? { extraFrom: extra.from, extraTo: extra.to } : {})
    });
}

/** Stock rows and their images for the inventory page. */
export function getStocksData(signal?: AbortSignal) {
    return callBundle<StocksPayload>('/api/stocks', signal);
}

/**
 * Financial accruals for specific days.
 *
 * Days rather than a range: a closed day never changes, so only the days still missing
 * from the local cache are requested. `withTypes` asks for the static type catalogue,
 * which is only needed until it has been stored once.
 */
export function getEconomicsData(
    signal: AbortSignal | undefined,
    dates: string[],
    withTypes = false
) {
    return callBundle<EconomicsPayload>('/api/economics', signal, {
        dates,
        withTypes
    });
}


/** One month of realization, balance and weekly settlement. */
export interface MonthFinancePayload extends MonthFinance {
    /** Set when the balance or the weekly breakdown failed; the month still renders. */
    partialError?: string;
}

/**
 * Only the realization report for a month.
 *
 * Used by the period cards: a revenue-based tax is charged on the realized revenue, which
 * only this monthly document states. One request instead of the three the full bundle costs.
 */
export interface MonthRealizationPayload {
    month: string;
    realization: MonthFinance['realization'];
    fetchedAt: string;
}

/**
 * A single month of financial figures.
 *
 * This is what reaches months the order feed cannot: Ozon's realization report is a monthly
 * document served for any month, so a month older than the loaded postings still answers.
 */
export function getMonthFinance(signal: AbortSignal | undefined, month: string) {
    return callBundle<MonthFinancePayload>('/api/finance', signal, { month });
}

/** The realization report alone, for the cards' tax base. */
export function getMonthRealization(signal: AbortSignal | undefined, month: string) {
    return callBundle<MonthRealizationPayload>('/api/finance', signal, {
        month,
        only: 'realization'
    });
}
