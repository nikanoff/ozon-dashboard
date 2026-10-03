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

/**
 * How far back orders are loaded by default, and the most the caller may ask for.
 *
 * The default is a rolling window long enough for the month view's default selection: the
 * selected month is the last one that closed, so covering it means reaching back to the first
 * day of the previous month, and over every day of 2025–2027 the worst case is 61 days.
 *
 * But a rolling default cannot cover a month chosen from the picker — August is already 64
 * days back in October — so the caller may state the window it needs with `windowFrom`, and
 * the page asks for the first day of the month it is showing. The cap bounds the cost: an
 * old month means more cursors to walk, and an unbounded request would let the picker's
 * twenty-four months fetch two years of orders in one load.
 */
const PERIOD_DAYS = 62;
const MAX_WINDOW_DAYS = 120;
/** The bento's widest window, measured back from today. */
const BENTO_WINDOW_DAYS = 31;
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
    const body = await readBody(request);

    const askedFrom = parseDate(body.windowFrom);
    const askedEnd = parseDate(body.windowTo);
    const requested = parseDate(body.since);

    const floor = new Date(to.getTime() - MAX_WINDOW_DAYS * DAY_MS);
    const defaultFrom = new Date(to.getTime() - PERIOD_DAYS * DAY_MS);

    // A caller that states both ends is asking for one bounded range — the month it is
    // showing — and may reach as far back as the picker goes: the walk costs the length of
    // that range, not its distance from today. A start with no end could span years, so it
    // stays clamped to the default reach.
    const bounded =
        askedFrom !== null && askedEnd !== null && askedEnd > askedFrom && askedEnd < to;
    const oldestAllowed =
        askedFrom && askedFrom < to && (bounded || askedFrom > floor) ? askedFrom : defaultFrom;

    /**
     * Which ranges to walk. Never more than two.
     *
     * A refresh re-reads the recent tail alone, because only that part can still change. A
     * full load covers the month on screen — and the bento, whose windows are anchored to
     * today rather than to the month, needs today's tail as well. Those two do not meet for
     * an old month, and walking the span between them would fetch a year of orders to display
     * one month, so they are fetched as two ranges and joined.
     */
    const windowEnd = bounded && askedEnd > oldestAllowed ? askedEnd : to;
    const recentFrom = new Date(to.getTime() - BENTO_WINDOW_DAYS * DAY_MS);
    const reachesToday = windowEnd >= new Date(to.getTime() - DAY_MS);

    let ranges: Array<[Date, Date]>;
    if (requested && requested > oldestAllowed && requested < to) {
        ranges = [[requested, to]];
    } else if (reachesToday) {
        ranges = [[oldestAllowed, to]];
    } else {
        ranges = [
            [oldestAllowed, windowEnd],
            [recentFrom, to]
        ];
    }

    try {
        const walks = await Promise.all(
            ranges.map(([rangeFrom, rangeTo]) =>
                collectFboPostings(credentials, rangeFrom, rangeTo, signal)
            )
        );

        // Ranges can overlap at their edges; a posting must not be counted twice.
        const byNumber = new Map<string, (typeof walks)[number][number]>();
        for (const walk of walks) {
            for (const posting of walk) byNumber.set(posting.posting_number, posting);
        }
        const postings = [...byNumber.values()];

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
            // The earliest edge of the fetched ranges: the client merges a later refresh
            // against this, so it has to be the start of what the payload holds.
            oldestAllowed: oldestAllowed.toISOString(),
            // What was actually walked, so the client can tell whether a payload covers the
            // month it is about to show. The earliest edge cannot answer that once two
            // disjoint ranges are possible.
            ranges: ranges.map(([rangeFrom, rangeTo]) => ({
                from: dayKey(rangeFrom),
                to: dayKey(rangeTo)
            }))
        });
    } catch (error) {
        return ozonErrorResponse(error, 'dashboard');
    }
};

async function readBody(
    request: Request
): Promise<{ since?: unknown; windowFrom?: unknown; windowTo?: unknown }> {
    try {
        return (await request.json()) as {
            since?: unknown;
            windowFrom?: unknown;
            windowTo?: unknown;
        };
    } catch {
        return {};
    }
}

function parseDate(value: unknown): Date | null {
    if (typeof value !== 'string') return null;

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `YYYY-MM-DD` in UTC, matching how the ranges are compared on the client.
 *
 * The client compares these as strings against the month's own keys, so a local-time
 * conversion here would shift a range by a day and make a payload look as though it covers
 * a month it does not.
 */
function dayKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}
