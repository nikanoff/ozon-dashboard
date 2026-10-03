import type { AccrualDaySummary } from './accruals';

/**
 * Turns accrual day summaries into a profit-and-loss view.
 *
 * One thing this module is careful about: `total_amount` is the truth. Nothing here
 * recomputes the net from the deductions, because fines, insurance and compensations carry no
 * fee lines at all and summing the lines would lose them.
 *
 * It used to attribute every deduction to a fee group as well, for a panel that grouped them
 * by meaning. That panel went when the monthly breakdown replaced it — the balance report
 * states the same money by Ozon's own categories and reconciles to the accrued total — so the
 * grouping, its labels and the line types went with it.
 */

export interface FinanceSummary {
    /** Money Ozon nets for orders: accruals that carry a posting number. */
    netOrders: number;
    /** Cabinet-level costs, reported apart from the orders. */
    netCabinet: number;
    /** Everything together, which is what reaches the account. */
    net: number;
    /** Seller-price side, where Ozon exposes it. */
    gross: number;
    /** Days that answered with data, and days Ozon reported nothing for. */
    daysWithData: number;
    emptyDays: string[];
    /**
     * Days the call failed for. Never folded into the totals, and never treated as a
     * zero: an integration gap must not read as a quiet period.
     */
    failedDays: { date: string; error?: string }[];
    /** Latest day that actually carries data. */
    lastDayWithData: string | null;
    /** Accruals behind the figures, so "no data" can be told from "small numbers". */
    accrualCount: number;
}

export function summariseFinance(
    days: AccrualDaySummary[],
    types: Record<string, string> = {}
): FinanceSummary {
    const usable = days.filter((day) => day.status !== 'failed');
    const failedDays = days
        .filter((day) => day.status === 'failed')
        .map((day) => ({ date: day.date, error: day.error }));

    const byType: Record<string, number> = {};
    const cabinetByType: Record<string, number> = {};
    let netOrders = 0;
    let netCabinet = 0;
    let gross = 0;
    let accrualCount = 0;
    for (const day of usable) {
        accrualCount += day.counts.total;
        gross += day.gross;
        // `cabinetByType.total` is the cabinet's own share of the day's net.
        netCabinet += day.cabinetByType.total ?? 0;
        netOrders += day.net - (day.cabinetByType.total ?? 0);
    }

    const withData = usable.filter((day) => day.status === 'ok');

    return {
        netOrders,
        netCabinet,
        net: netOrders + netCabinet,
        gross,
        daysWithData: withData.length,
        emptyDays: usable.filter((day) => day.status === 'empty').map((day) => day.date),
        failedDays,
        lastDayWithData:
            withData.length > 0
                ? withData.map((day) => day.date).sort()[withData.length - 1]
                : null,
        accrualCount
    };
}

/** A delivered order, reduced to what the in-transit check needs. */
export interface InTransitPosting {
    posting_number: string;
    status: string;
    created_at: string;
    /** Payout Ozon reported for the whole posting on the order card, if any. */
    expectedPayout: number | null;
}

export interface InTransit {
    /** Delivered orders Ozon has not accrued anything for yet. */
    orders: number;
    /** What those orders should bring, over the ones whose payout Ozon reported. */
    expectedPayout: number | null;
    /** How many of them carried a reported payout. */
    priced: number;
    /** The window the check covers; per-posting detail is kept only for recent days. */
    windowDays: number;
    /** The largest expected payouts, so the list is actionable. */
    postingNumbers: string[];
}

/**
 * Money for delivered orders that Ozon has not paid out yet.
 *
 * An order with no accrual is normal for the first days after delivery, which is exactly
 * why the distinction matters: a *growing* gap is a payout delay or a broken feed, while
 * a small steady one is just the settlement lag. Matching is done on the posting number,
 * which the accrual feed carries as `unit_number` under the same value it always had.
 */
export function moneyInTransit(
    days: AccrualDaySummary[],
    postings: InTransitPosting[],
    now = new Date(),
    windowDays = 14
): InTransit {
    const accrued = new Set<string>();
    let covered = 0;

    for (const day of days) {
        if (!day.byPosting) continue;
        covered += 1;
        for (const postingNumber of Object.keys(day.byPosting)) accrued.add(postingNumber);
    }

    // Without per-posting detail there is nothing to match against, so the check stays
    // silent instead of reporting every delivered order as unpaid.
    if (covered === 0) {
        return { orders: 0, expectedPayout: null, priced: 0, windowDays, postingNumbers: [] };
    }

    const since = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
    const pending: { postingNumber: string; payout: number | null }[] = [];

    for (const posting of postings) {
        if (posting.status !== 'delivered') continue;

        const created = new Date(posting.created_at).getTime();
        if (!Number.isFinite(created) || created < since) continue;
        if (accrued.has(posting.posting_number)) continue;

        pending.push({
            postingNumber: posting.posting_number,
            payout: posting.expectedPayout
        });
    }

    const pricedRows = pending.filter((row) => row.payout !== null);

    return {
        orders: pending.length,
        expectedPayout:
            pricedRows.length > 0
                ? pricedRows.reduce((sum, row) => sum + (row.payout ?? 0), 0)
                : null,
        priced: pricedRows.length,
        windowDays,
        postingNumbers: pending
            .sort((a, b) => (b.payout ?? 0) - (a.payout ?? 0))
            .slice(0, 5)
            .map((row) => row.postingNumber)
    };
}
