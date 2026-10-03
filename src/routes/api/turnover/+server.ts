import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCredentials } from '$lib/server/ozon';
import { ozonErrorResponse } from '$lib/server/errors';
import { collectTurnover } from '$lib/server/analytics';

/**
 * Ozon's own turnover grades.
 *
 * The method is limited to one request per minute, so the browser caches the answer and
 * asks again only occasionally; that caching is what makes it usable at all. A failure is
 * returned as an empty list with a message rather than an error status: this is an
 * enrichment, and the dashboard is complete without it.
 */
export const config = { maxDuration: 30 };

export const POST: RequestHandler = async ({ request }) => {
    const credentials = readCredentials(request);

    if (!credentials) {
        return json(
            { code: 16, message: 'Client-Id and Api-Key headers are required' },
            { status: 401 }
        );
    }

    try {
        const result = await collectTurnover(credentials, request.signal);

        return json({
            rows: result.rows,
            truncated: result.truncated,
            error: result.error ?? null,
            fetchedAt: new Date().toISOString()
        });
    } catch (error) {
        return ozonErrorResponse(error, 'turnover');
    }
};
