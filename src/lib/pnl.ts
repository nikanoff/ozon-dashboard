import type { AccrualDaySummary } from './accruals';

/**
 * Turns accrual day summaries into a profit-and-loss view.
 *
 * Two things this module is careful about:
 *
 *   1. `total_amount` is the truth. The lines below attribute the deductions; they are
 *      never summed into the net, because fines, insurance and compensations carry no
 *      fee lines at all and recomputing would lose them.
 *   2. Cabinet-level costs (storage, advertising, review collection) stay in their own
 *      block. Spreading them across orders makes a per-order figure stop matching the
 *      cabinet, and then every dispute is lost against the seller's own table.
 */

export type FeeGroup =
    | 'commission'
    | 'logistics'
    | 'acquiring'
    | 'returns'
    | 'storage'
    | 'ads'
    | 'compensation'
    | 'other';

/** Order in which the bridge reads, most material first. */
export const FEE_GROUP_ORDER: FeeGroup[] = [
    'commission',
    'logistics',
    'acquiring',
    'returns',
    'storage',
    'ads',
    'compensation',
    'other'
];

export const FEE_GROUP_LABELS: Record<FeeGroup, string> = {
    commission: 'Комиссия',
    logistics: 'Логистика',
    acquiring: 'Приём платежа',
    returns: 'Возвраты и невыкупы',
    storage: 'Хранение',
    ads: 'Продвижение',
    compensation: 'Компенсации',
    other: 'Прочее'
};

/**
 * Groups a fee by its catalogue name.
 *
 * Ozon's own wording is the only signal available, so the match is deliberately loose
 * and falls back to `other`, where the name is still displayed. Guessing a wrong group
 * is worse than showing an ungrouped line.
 */
export function classifyFee(name: string): FeeGroup {
    const value = name.toLowerCase();

    if (/компенсац|возмещен|compensat/.test(value)) return 'compensation';
    if (/возврат|невыкуп|return|storno|сторно/.test(value)) return 'returns';
    if (/хранен|размещен|storage|placement/.test(value)) return 'storage';
    if (/продвижен|реклам|маркетинг|advert|promo|marketing/.test(value)) return 'ads';
    if (/эквайринг|приём платеж|прием платеж|acquiring|payment/.test(value)) return 'acquiring';
    if (/последн|last.?mile/.test(value)) return 'logistics';
    if (/логистик|доставк|магистрал|обработк|сборк|logistic|deliver|fulfil|processing/.test(value)) {
        return 'logistics';
    }
    if (/комисси|commission/.test(value)) return 'commission';

    return 'other';
}

/** One attributed line of the bridge. */
export interface PnlLine {
    /** `type_id`, or `group:<name>` when the type has no name. */
    key: string;
    label: string;
    amount: number;
    group: FeeGroup;
}

/** The name for a fee type, falling back to the raw id rather than inventing one. */
export function typeLabel(typeId: string, types: Record<string, string>): string {
    return types[typeId] ?? `Тип начисления ${typeId}`;
}

function linesFrom(
    totals: Record<string, number>,
    types: Record<string, string>,
    skip: (key: string) => boolean
): PnlLine[] {
    return Object.entries(totals)
        .filter(([key, amount]) => !skip(key) && amount !== 0)
        .map(([key, amount]) => {
            const label = typeLabel(key, types);
            return { key, label, amount, group: classifyFee(label) };
        })
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

/**
 * Order-level deductions: every fee minus the ones that belong to cabinet-level accruals.
 *
 * The subtraction is per `type_id`, so a fee type that appears on both sides is split
 * correctly instead of landing entirely in one bucket.
 */
export function orderFees(
    byType: Record<string, number>,
    cabinetByType: Record<string, number>,
    types: Record<string, string>
): PnlLine[] {
    const net: Record<string, number> = {};

    for (const [key, amount] of Object.entries(byType)) {
        if (key === 'total') continue;
        net[key] = amount - (cabinetByType[key] ?? 0);
    }

    return linesFrom(net, types, () => false);
}

/** Cabinet-level costs, which are never attributed to an order. */
export function cabinetFees(
    cabinetByType: Record<string, number>,
    types: Record<string, string>
): PnlLine[] {
    return linesFrom(cabinetByType, types, (key) => key === 'total');
}

export interface FinanceSummary {
    /** Money Ozon nets for orders: accruals that carry a posting number. */
    netOrders: number;
    /** Cabinet-level costs, reported apart from the orders. */
    netCabinet: number;
    /** Everything together, which is what reaches the account. */
    net: number;
    /** Seller-price side, where Ozon exposes it. */
    gross: number;
    orderLines: PnlLine[];
    cabinetLines: PnlLine[];
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

        for (const [key, amount] of Object.entries(day.byType)) {
            byType[key] = (byType[key] ?? 0) + amount;
        }
        for (const [key, amount] of Object.entries(day.cabinetByType)) {
            if (key === 'total') continue;
            cabinetByType[key] = (cabinetByType[key] ?? 0) + amount;
        }
    }

    const withData = usable.filter((day) => day.status === 'ok');

    return {
        netOrders,
        netCabinet,
        net: netOrders + netCabinet,
        gross,
        orderLines: orderFees(byType, cabinetByType, types),
        cabinetLines: cabinetFees(cabinetByType, types),
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

/** Rolls attributed lines up into the eight bridge groups, for a compact view. */
export function groupTotals(lines: PnlLine[]): { group: FeeGroup; amount: number }[] {
    const totals = new Map<FeeGroup, number>();

    for (const line of lines) {
        totals.set(line.group, (totals.get(line.group) ?? 0) + line.amount);
    }

    return FEE_GROUP_ORDER.filter((group) => (totals.get(group) ?? 0) !== 0).map((group) => ({
        group,
        amount: totals.get(group) ?? 0
    }));
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
