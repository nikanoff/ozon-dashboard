import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCredentials } from '$lib/server/ozon';
import { ozonErrorResponse } from '$lib/server/errors';
import { collectMonthFinance } from '$lib/server/finance';
import { monthBounds } from '$lib/realization';

/**
 * One month of financial figures.
 *
 * Exists because the order feed is bounded: the dashboard can only ever load a recent
 * window of postings, so without this the period selector could not offer an older month.
 * Ozon's realization report is monthly and available for any month, so this turns "the
 * dashboard cannot see March" into a single request.
 *
 * Three Ozon calls per month, cached in the browser afterwards: the report for a closed
 * month never changes.
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

    let body: { month?: unknown } = {};
    try {
        body = (await request.json()) ?? {};
    } catch {
        // An absent body cannot name a month, which is handled below.
    }

    const month = typeof body.month === 'string' ? body.month.slice(0, 7) : '';

    // Only a real `YYYY-MM` reaches Ozon: anything else could ask for a period the
    // methods do not define.
    if (!monthBounds(month)) {
        return json({ code: 3, message: 'month must be YYYY-MM' }, { status: 400 });
    }

    const { signal } = request;

    try {
        const result = await collectMonthFinance(credentials, month, signal);

        if (signal.aborted) {
            return json({ message: 'Request aborted' }, { status: 499 });
        }

        return json(result);
    } catch (error) {
        return ozonErrorResponse(error, 'finance');
    }
};
