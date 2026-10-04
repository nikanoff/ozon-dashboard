import type { DashboardPayload, DashboardPosting, OzonReturn } from './ozon_types';

/**
 * Incremental refresh.
 *
 * The dashboard loads 62 days of orders, but only the recent tail of that history can still
 * change (a posting moves from awaiting_packaging to delivered, or gets cancelled). A refresh
 * therefore re-reads just the tail and folds it into the payload already on screen, instead
 * of downloading the whole window again.
 */

/** How far back a refresh re-reads. Older postings are treated as settled. */
export const REFRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const time = (iso: string) => new Date(iso).getTime();

/**
 * A partial refresh only works when it overlaps what the client already holds:
 * otherwise the gap between the cached range and the refreshed range would be
 * missing from the statistics, so a full load is needed instead.
 */
export function needsFullLoad(
    previous: DashboardPayload | undefined,
    now = Date.now()
): boolean {
    if (!previous) return true;

    const fetchedAt = time(previous.fetchedAt);
    return !Number.isFinite(fetchedAt) || now - fetchedAt > REFRESH_WINDOW_MS;
}

/** The `since` to ask the server for when refreshing incrementally. */
export function refreshSince(now = Date.now()): string {
    return new Date(now - REFRESH_WINDOW_MS).toISOString();
}

/**
 * Whether a payload already holds the window being asked for.
 *
 * Asked of the ranges the payload was fetched with, not of its earliest edge. A payload can
 * hold two disjoint ranges — the month on screen and today's tail, with the months between
 * them never fetched — and then the earliest edge is the older range's start. That start sits
 * *before* a later month, so comparing against it claims coverage the payload does not have.
 *
 * It cost the first day of September: a payload holding August 2025 beside a tail from
 * 2 September reported 2025-08-01 as its edge, was judged to cover September, and was merged
 * with a tail that had nothing for the 1st. A payload from an older build has no ranges and
 * is treated as not covering anything, which costs a full load and nothing else.
 */
export function coversWindow(
    payload: DashboardPayload | undefined,
    from: string,
    to: string
): boolean {
    return payload?.ranges?.some((range) => range.from <= from && range.to >= to) ?? false;
}

/**
 * Folds a partial refresh into the payload on screen: fresh rows win (their status
 * may have changed), everything else is kept until it falls out of the widest
 * period the dashboard shows.
 */
export function mergeDashboardPayload(
    previous: DashboardPayload,
    fresh: DashboardPayload
): DashboardPayload {
    const oldestAllowed = time(fresh.oldestAllowed);
    const byPostingNumber = new Map<string, DashboardPosting>();

    for (const posting of previous.postings) {
        byPostingNumber.set(posting.posting_number, posting);
    }
    for (const posting of fresh.postings) {
        byPostingNumber.set(posting.posting_number, posting);
    }

    return {
        postings: [...byPostingNumber.values()].filter(
            (posting) => time(posting.created_at) >= oldestAllowed
        ),
        skuToImage: { ...previous.skuToImage, ...fresh.skuToImage },
        fetchedAt: fresh.fetchedAt,
        oldestAllowed: fresh.oldestAllowed,
        // The ranges the fresh request covered: what the merged payload can now be said to
        // hold. A merged payload keeps the older rows, but only within these edges.
        ranges: fresh.ranges ?? previous.ranges,
        returns: mergeReturns(previous, fresh),
        returnsWindow: fresh.returnsWindow ?? previous.returnsWindow
    };
}

/**
 * Returns for the merged payload: the fresh window wins, older rows are kept.
 *
 * Keyed by the return's own identifier rather than by date, because a refresh re-reads the
 * whole previous month as well — the cards need it — and a date-keyed merge would either
 * duplicate those rows or drop the ones a return's date moved out of.
 */
function mergeReturns(previous: DashboardPayload, fresh: DashboardPayload): OzonReturn[] {
    // A payload from an older build carries no returns at all: keeping the fresh ones is
    // the whole answer, and the cards show a gap for the months it never had.
    if (!fresh.returns) return previous.returns ?? [];

    const freshFrom = fresh.returnsWindow?.from;
    const byId = new Map<number, OzonReturn>();

    for (const row of previous.returns ?? []) {
        if (freshFrom && row.date >= freshFrom) continue;
        byId.set(row.id, row);
    }
    for (const row of fresh.returns) byId.set(row.id, row);

    return [...byId.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}
