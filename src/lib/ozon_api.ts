import { get } from 'svelte/store';
import { ozonKeys } from './stores/ozon_keys';

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

    if (!response.ok) {
        throw new Error(`Ozon API error: ${response.statusText}`);
    }

    return await response.json();
}



export async function getStocks() {
    return callOzon('/v4/product/info/stocks', {
        filter: { visibility: 'ALL' },
        limit: 1000
    });
}

export async function getFboPostings(since: string, to: string) {
    return callOzon('/v2/posting/fbo/list', {
        dir: 'ASC',
        filter: {
            since: since,
            to: to,
            status: ''
        },
        limit: 1000,
        offset: 0,
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
