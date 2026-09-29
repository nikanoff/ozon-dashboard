import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { collectFboPostings, collectProductInfo, readCredentials } from '$lib/server/ozon';
import { ozonErrorResponse } from '$lib/server/errors';
import { buildSkuImageMap, toDashboardPosting } from '$lib/ozon_map';

/**
 * The dashboard payload in a single request.
 *
 * Vercel runs this as one Node function: the walk is bounded (about a second in the
 * worst case measured, plus cold start), so 30 s leaves generous headroom.
 */
export const config = { maxDuration: 30 };

/** Widest period the dashboard shows. */
const PERIOD_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export const POST: RequestHandler = async ({ request }) => {
    const credentials = readCredentials(request);

    if (!credentials) {
        return json(
            { code: 16, message: 'Client-Id and Api-Key headers are required' },
            { status: 401 }
        );
    }

    // Stop the upstream work as soon as the browser gives up: on serverless this
    // frees the invocation instead of finishing a request nobody will read.
    const { signal } = request;

    const to = new Date();
    const oldestAllowed = new Date(to.getTime() - PERIOD_DAYS * DAY_MS);

    // A refresh may ask for the recent tail only; anything outside the retained
    // period is ignored, and an unusable value falls back to a full load.
    const requested = parseDate((await readBody(request)).since);
    const from = requested && requested > oldestAllowed && requested < to ? requested : oldestAllowed;

    try {
        const postings = await collectFboPostings(credentials, from, to, signal);

        const skus = [
            ...new Set(
                postings.flatMap((posting) =>
                    (posting.products ?? []).map((product) => product.sku)
                )
            )
        ];
        const products =
            skus.length > 0 ? await collectProductInfo(credentials, skus, signal) : [];

        return json({
            postings: postings.map(toDashboardPosting),
            skuToImage: buildSkuImageMap(products),
            fetchedAt: to.toISOString(),
            oldestAllowed: oldestAllowed.toISOString()
        });
    } catch (error) {
        return ozonErrorResponse(error, 'dashboard');
    }
};

async function readBody(request: Request): Promise<{ since?: unknown }> {
    try {
        return (await request.json()) as { since?: unknown };
    } catch {
        return {};
    }
}

function parseDate(value: unknown): Date | null {
    if (typeof value !== 'string') return null;

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}
