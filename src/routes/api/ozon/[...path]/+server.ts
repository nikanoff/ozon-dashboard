import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { OZON_CLIENT_ID, OZON_API_KEY, OZON_BASE_URL } from '$lib/ozon_config';

// Headers returned by Ozon that describe the current rate limits.
// Ozon uses non-standard names (Item-Retry-After / Item-Rate-Limit-Remaining),
// so we forward both those and the conventional spellings.
const RATE_LIMIT_HEADERS = [
    'retry-after',
    'item-retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'item-rate-limit-remaining'
];

export const POST: RequestHandler = async ({ request, url }) => {
    // Extract the path from the URL, removing the '/api/ozon' prefix
    const path = url.pathname.replace('/api/ozon', '');
    const targetUrl = `${OZON_BASE_URL}${path}`;

    let body: unknown = {};
    try {
        body = await request.json();
    } catch {
        // Some Ozon methods accept an empty body; fall back to an empty object.
        body = {};
    }

    const headerClientId = request.headers.get('X-Ozon-Client-Id');
    const headerApiKey = request.headers.get('X-Ozon-Api-Key');

    const clientId = headerClientId !== null ? headerClientId : OZON_CLIENT_ID;
    const apiKey = headerApiKey !== null ? headerApiKey : OZON_API_KEY;

    if (!clientId || !apiKey) {
        return json(
            { code: 16, message: 'Client-Id and Api-Key headers are required' },
            { status: 401 }
        );
    }

    let response: Response;
    try {
        response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Client-Id': clientId,
                'Api-Key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
    } catch (error) {
        // `fetch` throws a generic "fetch failed" for network/TLS errors. The real
        // cause (e.g. certificate problems) is hidden in `error.cause`, so log it.
        console.error('Ozon API proxy request failed:', error, (error as any)?.cause);
        return json(
            { error: 'Failed to reach Ozon API', detail: String((error as any)?.cause ?? error) },
            { status: 502 }
        );
    }

    // Ozon may answer with an empty body or HTML (e.g. on gateway errors), so we
    // can't assume JSON. Read the text first and parse defensively.
    const raw = await response.text();
    let data: unknown;
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = { error: 'Unexpected non-JSON response from Ozon API', raw: raw.slice(0, 500) };
    }

    const headers = new Headers();
    for (const name of RATE_LIMIT_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) {
            headers.set(name, value);
        }
    }

    if (response.status === 429) {
        console.warn('Ozon API rate limit hit (429) for', path);
    }

    return json(data, { status: response.status, headers });
};
