import type {
    OzonPicturesResponse,
    OzonPosting,
    OzonPostingsResponse,
    OzonProductInfo,
    OzonProductInfoListResponse,
    OzonProductPicture,
    OzonStockItem,
    OzonStocksResponse
} from '$lib/ozon_types';

/**
 * Server-side Ozon client.
 *
 * Everything a page needs is assembled here, in a single invocation, instead of the
 * browser walking the cursor across several round trips. The posting walk is split
 * into time windows fetched in parallel — that is what makes one request fast:
 * 31 days / 523 postings went from ~690 ms sequential to ~120 ms this way.
 */

const OZON_BASE_URL = 'https://api-seller.ozon.ru';

/** Largest page the id-based list methods accept. */
const PAGE_LIMIT = 1000;
/** Posting pages are capped at 100 rows by Ozon. */
const POSTINGS_PAGE_LIMIT = 100;
/** Bounds a single walk; a runaway cursor must not hang the function. */
const MAX_PAGES_PER_WINDOW = 50;
/** One window per this many days, capped by MAX_WINDOWS. */
const WINDOW_DAYS = 4;
const MAX_WINDOWS = 8;
/** Parallel window walks, kept well under what Ozon tolerated in testing. */
const WINDOW_CONCURRENCY = 8;
/** Parallel chunk requests for the id-based collectors. */
const CHUNK_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Credentials {
    clientId: string;
    apiKey: string;
}

export class OzonRequestError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly retryAfterSeconds?: number
    ) {
        super(message);
        this.name = 'OzonRequestError';
    }
}

/** Reads the per-request credentials; there are no server-side keys by design. */
export function readCredentials(request: Request): Credentials | null {
    const clientId = request.headers.get('X-Ozon-Client-Id')?.trim() ?? '';
    const apiKey = request.headers.get('X-Ozon-Api-Key')?.trim() ?? '';

    return clientId && apiKey ? { clientId, apiKey } : null;
}

async function callOzon<T>(
    path: string,
    body: unknown,
    credentials: Credentials,
    signal?: AbortSignal
): Promise<T> {
    const response = await fetch(`${OZON_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            'Client-Id': credentials.clientId,
            'Api-Key': credentials.apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal
    });

    // Ozon answers with plain text or HTML on gateway errors, so parse defensively.
    const raw = await response.text();
    let data: unknown = {};
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = { message: raw.slice(0, 300) };
    }

    if (!response.ok) {
        const retryAfter = Number(
            response.headers.get('item-retry-after') ?? response.headers.get('retry-after')
        );

        throw new OzonRequestError(
            response.status,
            (data as { message?: string })?.message ??
                `Ozon API error: ${response.status} ${response.statusText}`,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
        );
    }

    return data as T;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries rate-limited calls instead of failing the whole page. */
async function callOzonWithRetry<T>(
    path: string,
    body: unknown,
    credentials: Credentials,
    signal?: AbortSignal
): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await callOzon<T>(path, body, credentials, signal);
        } catch (error) {
            const throttled = error instanceof OzonRequestError && error.status === 429;

            if (!throttled || attempt >= MAX_ATTEMPTS) {
                throw error;
            }

            const waitMs = Math.min(
                (error.retryAfterSeconds ?? 1) * 1000,
                MAX_RETRY_DELAY_MS
            );
            await delay(waitMs);
        }
    }
}

/** Runs `worker` over `items` with a bounded number of calls in flight. */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await worker(items[index], index);
        }
    });

    await Promise.all(runners);
    return results;
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

/** Splits a period into touching windows, newest first. */
function splitIntoWindows(from: Date, to: Date) {
    const spanMs = Math.max(to.getTime() - from.getTime(), 1);
    const count = Math.min(
        MAX_WINDOWS,
        Math.max(1, Math.ceil(spanMs / (WINDOW_DAYS * DAY_MS)))
    );
    const stepMs = spanMs / count;

    return Array.from({ length: count }, (_, index) => ({
        since: new Date(to.getTime() - (index + 1) * stepMs).toISOString(),
        to: new Date(to.getTime() - index * stepMs).toISOString()
    }));
}

const FBO_STATUSES = [
    'awaiting_packaging',
    'awaiting_deliver',
    'delivering',
    'delivered',
    'cancelled'
];

/** Walks one window, following its cursor. */
async function collectWindow(
    credentials: Credentials,
    window: { since: string; to: string },
    signal?: AbortSignal
): Promise<OzonPosting[]> {
    const postings: OzonPosting[] = [];
    let cursor = '';

    for (let page = 0; page < MAX_PAGES_PER_WINDOW; page += 1) {
        const response = await callOzonWithRetry<OzonPostingsResponse>(
            '/v3/posting/fbo/list',
            {
                cursor,
                filter: {
                    since: window.since,
                    to: window.to,
                    statuses: FBO_STATUSES
                },
                limit: POSTINGS_PAGE_LIMIT,
                sort_dir: 'DESC',
                translit: true,
                with: { analytics_data: true, financial_data: true }
            },
            credentials,
            signal
        );

        postings.push(...(response.postings ?? []));

        if (!response.has_next || !response.cursor) {
            break;
        }
        cursor = response.cursor;
    }

    return postings;
}

export async function collectFboPostings(
    credentials: Credentials,
    from: Date,
    to: Date,
    signal?: AbortSignal
): Promise<OzonPosting[]> {
    const windows = splitIntoWindows(from, to);
    const batches = await mapWithConcurrency(windows, WINDOW_CONCURRENCY, (window) =>
        collectWindow(credentials, window, signal)
    );

    // Windows touch at their boundaries and `since`/`to` are inclusive, so the same
    // posting can arrive twice.
    const byPostingNumber = new Map<string, OzonPosting>();
    for (const batch of batches) {
        for (const posting of batch) {
            byPostingNumber.set(posting.posting_number, posting);
        }
    }

    return [...byPostingNumber.values()];
}

/** Follows the stock cursor: one page holds at most PAGE_LIMIT products. */
export async function collectStocks(
    credentials: Credentials,
    signal?: AbortSignal
): Promise<OzonStockItem[]> {
    const items: OzonStockItem[] = [];
    let cursor = '';

    for (let page = 0; page < MAX_PAGES_PER_WINDOW; page += 1) {
        const body: Record<string, unknown> = {
            filter: { visibility: 'ALL' },
            limit: PAGE_LIMIT
        };
        if (cursor) {
            body.cursor = cursor;
        }

        const response = await callOzonWithRetry<OzonStocksResponse>(
            '/v4/product/info/stocks',
            body,
            credentials,
            signal
        );

        const batch = response.items ?? [];
        items.push(...batch);

        const total = response.total_items ?? response.total;
        if (!response.cursor || batch.length === 0) {
            break;
        }
        if (typeof total === 'number' && items.length >= total) {
            break;
        }
        if (response.cursor === cursor) {
            break;
        }
        cursor = response.cursor;
    }

    return items;
}

export async function collectProductInfo(
    credentials: Credentials,
    skus: number[],
    signal?: AbortSignal
): Promise<OzonProductInfo[]> {
    const batches = await mapWithConcurrency(
        chunk(skus, PAGE_LIMIT),
        CHUNK_CONCURRENCY,
        async (ids) => {
            const response = await callOzonWithRetry<OzonProductInfoListResponse>(
                '/v3/product/info/list',
                { sku: ids },
                credentials,
                signal
            );
            return response.items ?? [];
        }
    );

    return batches.flat();
}

export async function collectPictures(
    credentials: Credentials,
    productIds: string[],
    signal?: AbortSignal
): Promise<OzonProductPicture[]> {
    const batches = await mapWithConcurrency(
        chunk(productIds, PAGE_LIMIT),
        CHUNK_CONCURRENCY,
        async (ids) => {
            const response = await callOzonWithRetry<OzonPicturesResponse>(
                '/v2/product/pictures/info',
                { product_id: ids },
                credentials,
                signal
            );
            return response.items ?? [];
        }
    );

    return batches.flat();
}
