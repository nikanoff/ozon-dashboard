import { get } from 'svelte/store';
import { ozonKeys } from './stores/ozon_keys';

export interface OzonApiError extends Error {
    status: number;
    /** Raw response body from the proxy, if available. */
    payload: unknown;
}

function makeError(response: Response, payload: unknown): OzonApiError {
    const message =
        (payload as any)?.message ||
        `Ozon API error: ${response.status} ${response.statusText}`;

    const error = new Error(message) as OzonApiError;
    error.status = response.status;
    error.payload = payload;
    return error;
}

export async function callOzon(path: string, body: any) {
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
}

export async function getStocks() {
    return callOzon('/v4/product/info/stocks', {
        filter: { visibility: 'ALL' },
        limit: 1000
    });
}

// v3 caps a single response at 100 postings, so the 31-day statistics need the
// cursor followed across pages. Requests are issued one after another (each page
// needs the previous cursor), keeping the request rate well below Ozon's limit.
const FBO_STATUSES = [
    'awaiting_packaging',
    'awaiting_deliver',
    'delivering',
    'delivered',
    'cancelled'
];

/**
 * Loads every page of FBO postings for the period.
 *
 * Replaces the v2 method, which Ozon disabled on 1 June 2026. v3 differs in
 * several ways: sorting uses `sort_dir`, pagination uses a `cursor` instead of
 * `offset`, statuses are passed as an array, and items are nested under
 * `postings` in the response.
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
                statuses: FBO_STATUSES
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
