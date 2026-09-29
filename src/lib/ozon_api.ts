import { get } from 'svelte/store';
import { ozonKeys } from './stores/ozon_keys';
import type { DashboardPayload, StocksPayload } from './ozon_types';

export interface OzonApiError extends Error {
    status: number;
    /** Raw response body from the endpoint, if available. */
    payload: unknown;
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
 * that into the payload it already holds.
 */
export function getDashboardData(signal?: AbortSignal, since?: string) {
    return callBundle<DashboardPayload>(
        '/api/dashboard',
        signal,
        since ? { since } : {}
    );
}

/** Stock rows and their images for the inventory page. */
export function getStocksData(signal?: AbortSignal) {
    return callBundle<StocksPayload>('/api/stocks', signal);
}
