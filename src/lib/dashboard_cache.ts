import type { DashboardPayload, DashboardPosting } from './ozon_types';

/**
 * Incremental refresh.
 *
 * The dashboard covers 31 days, but only the recent tail of that history can still
 * change (a posting moves from awaiting_packaging to delivered, or gets cancelled).
 * A refresh therefore re-reads just the tail and folds it into the payload already
 * on screen, instead of downloading the whole month again.
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
        oldestAllowed: fresh.oldestAllowed
    };
}
