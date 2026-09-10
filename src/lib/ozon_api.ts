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

export async function getFboPostings(since: string, to: string) {
    return callOzon('/v2/posting/fbo/list', {
        dir: 'DESC',
        filter: {
            since: since,
            to: to,
            status: ''
        },
        limit: 1000,
        offset: 0,
        translit: true,
        with: {
            analytics_data: true,
            financial_data: true
        }
    });
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
