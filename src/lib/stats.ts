import type { OzonPosting, OzonPostingProduct } from './ozon_types';

export interface PeriodStats {
    count: number;
    sum: number;
    cancelled: number;
    cancelledSum: number;
    netSum: number;
    crossCluster: number;
}

export interface DashboardStats {
    last24h: PeriodStats;
    last7d: PeriodStats;
    last31d: PeriodStats;
    calendarDay: PeriodStats;
    calendarWeek: PeriodStats;
    calendarMonth: PeriodStats;
}

export const PERIOD_KEYS = [
    'last24h',
    'last7d',
    'last31d',
    'calendarDay',
    'calendarWeek',
    'calendarMonth'
] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

const CANCELLED_STATUS = 'cancelled';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function emptyPeriod(): PeriodStats {
    return { count: 0, sum: 0, cancelled: 0, cancelledSum: 0, netSum: 0, crossCluster: 0 };
}

export function emptyStats(): DashboardStats {
    return {
        last24h: emptyPeriod(),
        last7d: emptyPeriod(),
        last31d: emptyPeriod(),
        calendarDay: emptyPeriod(),
        calendarWeek: emptyPeriod(),
        calendarMonth: emptyPeriod()
    };
}

/**
 * Reads a product's unit price.
 *
 * v3 returns `price` as `{ amount, currency }`; the withdrawn v2 method returned a
 * plain string. Both shapes are accepted so totals never become NaN.
 */
export function productUnitPrice(product: OzonPostingProduct | undefined): number {
    const raw =
        typeof product?.price === 'object' && product.price !== null
            ? product.price.amount
            : product?.price;

    const value = parseFloat(String(raw));
    return Number.isFinite(value) ? value : 0;
}

/** Gross value of a posting: unit price times quantity, summed over its products. */
export function postingTotal(posting: OzonPosting): number {
    return (posting.products || []).reduce(
        (total, product) => total + productUnitPrice(product) * (product.quantity || 1),
        0
    );
}

/** True when a posting was shipped between two different Ozon clusters. */
export function isCrossCluster(posting: OzonPosting): boolean {
    const from = posting.financial_data?.cluster_from;
    const to = posting.financial_data?.cluster_to;
    return Boolean(from && to && from !== to);
}

/** Start instant of each of the six windows, relative to `now`. */
function periodLimits(now: Date): Record<PeriodKey, Date> {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // The week starts on Monday.
    const weekday = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - weekday + (weekday === 0 ? -6 : 1));
    startOfWeek.setHours(0, 0, 0, 0);

    const before = (ms: number) => new Date(now.getTime() - ms);

    return {
        last24h: before(DAY),
        last7d: before(7 * DAY),
        last31d: before(31 * DAY),
        calendarDay: startOfDay,
        calendarWeek: startOfWeek,
        calendarMonth: startOfMonth
    };
}

/**
 * Aggregates postings into the six dashboard periods.
 *
 * Every posting counts once per period it falls into, keyed off `created_at` (order
 * time, not shipment time). Cancellations are excluded from `count` and reported
 * separately, so `netSum` is gross minus cancelled revenue. `now` is injectable to
 * keep results deterministic in tests.
 */
export function calculateStats(postings: OzonPosting[], now = new Date()): DashboardStats {
    const stats = emptyStats();
    const limits = periodLimits(now);

    for (const posting of postings) {
        const createdAt = new Date(posting.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;

        const total = postingTotal(posting);
        const cancelled = posting.status === CANCELLED_STATUS;
        const crossCluster = isCrossCluster(posting);

        for (const key of PERIOD_KEYS) {
            if (createdAt < limits[key]) continue;

            const period = stats[key];
            period.sum += total;

            if (cancelled) {
                period.cancelled += 1;
                period.cancelledSum += total;
            } else {
                period.count += 1;
            }

            if (crossCluster) {
                period.crossCluster += 1;
            }
        }
    }

    for (const key of PERIOD_KEYS) {
        stats[key].netSum = stats[key].sum - stats[key].cancelledSum;
    }

    return stats;
}
