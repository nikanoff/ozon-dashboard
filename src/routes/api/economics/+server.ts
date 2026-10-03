import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCredentials } from '$lib/server/ozon';
import { ozonErrorResponse } from '$lib/server/errors';
import { collectAccrualDates, collectAccrualTypes } from '$lib/server/accruals';
import { MAX_ACCRUAL_DAYS } from '$lib/accruals';

/**
 * Financial accruals for a set of days.
 *
 * `/v1/finance/accrual/by-day` covers one day per call, so a 31-day window costs 31
 * requests. Closed days never change, which is why the caller sends the specific days it
 * is missing rather than a range: the first visit walks the window, every later visit
 * asks for yesterday and today.
 *
 * A window is still accepted for the cold start, where nothing is cached yet.
 */
export const config = { maxDuration: 30 };

/** Only a plain local calendar day is accepted; nothing else can be a query to Ozon. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function localDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/** Yesterday and today are still moving; everything older is settled. */
function recentDays(count: number): string[] {
    const days: string[] = [];
    const cursor = new Date();

    for (let index = 0; index < count; index += 1) {
        days.unshift(localDay(cursor));
        cursor.setDate(cursor.getDate() - 1);
    }

    return days;
}

export const POST: RequestHandler = async ({ request }) => {
    const credentials = readCredentials(request);

    if (!credentials) {
        return json(
            { code: 16, message: 'Client-Id and Api-Key headers are required' },
            { status: 401 }
        );
    }

    let body: { dates?: unknown; days?: unknown; withTypes?: unknown } = {};
    try {
        body = (await request.json()) ?? {};
    } catch {
        // An absent body is valid: fall back to the default window.
    }

    const today = localDay(new Date());

    let dates: string[];
    if (Array.isArray(body.dates)) {
        dates = [
            ...new Set(
                body.dates
                    .filter((day): day is string => typeof day === 'string')
                    .map((day) => day.slice(0, 10))
                    // A future day cannot have accruals, and a malformed one must never
                    // reach Ozon.
                    .filter((day) => DAY_PATTERN.test(day) && day <= today)
            )
        ]
            .sort()
            .slice(-MAX_ACCRUAL_DAYS);
    } else {
        const requested = Number(body.days);
        const count = Number.isFinite(requested)
            ? Math.min(Math.max(Math.trunc(requested), 1), MAX_ACCRUAL_DAYS)
            : 31;
        dates = recentDays(count);
    }

    if (dates.length === 0) {
        return json({ days: [], types: {}, fetchedAt: new Date().toISOString() });
    }

    const { signal } = request;

    try {
        const days = await collectAccrualDates(credentials, dates, signal);

        if (signal.aborted) {
            return json({ message: 'Request aborted' }, { status: 499 });
        }

        // Every day failing means the method itself is unusable: the key lacks access,
        // or the endpoint changed again. A payload full of failures would hide that
        // behind a plausible-looking zero, so it is reported as an error instead.
        if (days.every((day) => day.status === 'failed')) {
            return json(
                { code: 0, message: days[0]?.error ?? 'Начисления недоступны' },
                { status: 502 }
            );
        }

        // The type catalogue is static, so it is only fetched when the caller says it
        // has none — otherwise every incremental load would pay for a second request.
        const types = body.withTypes === true ? await collectAccrualTypes(credentials, signal) : {};

        return json({
            days,
            types,
            fetchedAt: new Date().toISOString()
        });
    } catch (error) {
        return ozonErrorResponse(error, 'economics');
    }
};
