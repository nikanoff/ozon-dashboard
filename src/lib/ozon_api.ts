import { get } from 'svelte/store';
import { ozonKeys } from './stores/ozon_keys';

export interface OzonApiError extends Error {
    status: number;
    /** Milliseconds to wait before retrying, derived from the Retry-After header. */
    retryAfterMs: number;
    /** Raw response body from the proxy, if available. */
    payload: unknown;
}

function makeError(response: Response, payload: unknown): OzonApiError {
    // Ozon sends the wait time as `Item-Retry-After`; fall back to the standard
    // `Retry-After` for gateways/proxies that normalise it.
    const retryAfterHeader =
        response.headers.get('Item-Retry-After') ?? response.headers.get('Retry-After');
    const retryAfter = Number(retryAfterHeader);
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;

    const remaining = (payload as any)?.message;
    let message = remaining;
    if (!message) {
        if (response.status === 429) {
            const wait =
                retryAfterMs > 0
                    ? ` Повторите через ${Math.ceil(retryAfterMs / 1000)} с.`
                    : '';
            message = `Превышен лимит запросов Ozon (429).${wait}`;
        } else {
            message = `Ozon API error: ${response.status} ${response.statusText}`;
        }
    }

    const error = new Error(message) as OzonApiError;
    error.status = response.status;
    error.retryAfterMs = retryAfterMs;
    error.payload = payload;
    return error;
}

// Ozon enforces per-method rate limits. `/v2/posting/fbo/list` answers with
// `429 code:8 "You have reached request rate limit per second"` when called too
// often, and a 1s gap sits exactly on the edge of that limit. We use a wider gap
// and serialise requests globally (see below).
const REQUEST_GAP_MS = 3000;

// All requests from this tab are chained: each one starts only after the
// previous settles, so the dashboard never fires Ozon calls in parallel.
let requestChain: Promise<unknown> = Promise.resolve();

// Requests are serialised per browser via localStorage so that multiple open
// tabs share one queue instead of each hammering Ozon independently.
const GATE_KEY = 'ozon_request_gate';
const GATE_STALE_MS = 60 * 1000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until no other tab has used the API within the last REQUEST_GAP_MS.
 *
 * The timestamp is kept in localStorage and claimed with a "reservation" that
 * is written before the wait, so two tabs cannot both pass the check at once.
 */
async function waitForGlobalSlot(): Promise<void> {
    if (typeof localStorage === 'undefined') {
        return;
    }

    for (let attempt = 0; attempt < 60; attempt += 1) {
        const now = Date.now();
        const lastUsed = Number(localStorage.getItem(GATE_KEY)) || 0;
        const elapsed = now - lastUsed;

        // Treat an implausibly old timestamp as "free" so a crashed tab that
        // left a reservation behind cannot block the gate forever.
        if (elapsed < 0 || elapsed > GATE_STALE_MS) {
            localStorage.setItem(GATE_KEY, String(now));
            return;
        }

        if (elapsed >= REQUEST_GAP_MS) {
            // Reserve the slot before returning so another tab sees the update.
            localStorage.setItem(GATE_KEY, String(now));
            return;
        }

        await delay(REQUEST_GAP_MS - elapsed);
    }
}

async function withRateLimitGate<T>(task: () => Promise<T>): Promise<T> {
    const run = requestChain.then(async () => {
        await waitForGlobalSlot();
        const result = await task();
        return result;
    });

    // Keep the chain alive even when a request rejects, otherwise every later
    // call would immediately fail with the same error.
    requestChain = run.catch(() => undefined);

    return run;
}

export async function callOzon(path: string, body: any) {
    return withRateLimitGate(async () => {
        const keys = get(ozonKeys);

        const response = await fetch(`/api/ozon${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Ozon-Client-Id': keys.clientId,
                'X-Ozon-Api-Key': keys.apiKey
            },
            body: JSON.stringify(body)
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

        return payload;
    });
}

export async function getStocks() {
    return callOzon('/v4/product/info/stocks', {
        filter: { visibility: 'ALL' },
        limit: 1000
    });
}

/**
 * Fetches FBO postings via the v3 method.
 *
 * The v2 method (`/v2/posting/fbo/list`) was disabled by Ozon on 1 June 2026 and
 * now always answers `429 code:8`. v3 differs in several breaking ways: sorting
 * uses `sort_dir`, pagination uses a `cursor` instead of `offset`, statuses are
 * passed as an array, and the response nests items under `postings`.
 */
export async function getFboPostings(since: string, to: string) {
    return callOzon('/v3/posting/fbo/list', {
        filter: {
            since: since,
            to: to,
            statuses: [
                'awaiting_packaging',
                'awaiting_deliver',
                'delivering',
                'delivered',
                'cancelled'
            ]
        },
        limit: 100,
        sort_dir: 'DESC',
        translit: true,
        with: {
            analytics_data: true,
            financial_data: true
        }
    });
}

/**
 * Loads every page of FBO postings for the period by following the `cursor`
 * returned by v3. The dashboard needs the full period for its statistics.
 */
export async function getAllFboPostings(since: string, to: string) {
    const postings: any[] = [];
    let cursor = '';

    // Guard against a server that never reports `has_next: false`.
    for (let page = 0; page < 50; page += 1) {
        const response: any = await callOzon('/v3/posting/fbo/list', {
            cursor,
            filter: {
                since,
                to,
                statuses: [
                    'awaiting_packaging',
                    'awaiting_deliver',
                    'delivering',
                    'delivered',
                    'cancelled'
                ]
            },
            limit: 100,
            sort_dir: 'DESC',
            translit: true,
            with: {
                analytics_data: true,
                financial_data: true
            }
        });

        postings.push(...(response?.postings || []));

        if (!response?.has_next || !response?.cursor) {
            break;
        }
        cursor = response.cursor;
    }

    return { postings, result: postings };
}

export async function getProductImages(productIds: string[]) {
    return callOzon('/v2/product/pictures/info', {
        product_id: productIds
    });
}

export async function getProductInfoList(skus: number[]) {
    return callOzon('/v3/product/info/list', {
        sku: skus
    });
}
