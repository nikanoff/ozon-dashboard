import type { DashboardPosting } from './ozon_types';
import { postingTotal, postingUnits, productUnitPrice } from './stats';

/**
 * Tier-2 analytics: everything here is derived from the postings the dashboard
 * already holds, so it costs no extra request to Ozon. These run on the wire shape
 * the browser renders (`DashboardPosting`), which carries the flattened `actions`
 * list. Cancelled postings are left out of every ranking (they are not sales) but
 * stay in the raw period totals.
 */

const DAY = 24 * 60 * 60 * 1000;

const isCancelled = (posting: DashboardPosting) => posting.status === 'cancelled';

const dateKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
    ).padStart(2, '0')}`;

/**
 * Revenue and order count over the half-open window `(from, to]`.
 *
 * The lower bound is exclusive so that two adjacent windows never both count a
 * posting created exactly on their shared boundary, which would inflate the
 * comparison. `revenue` includes cancellations, `netRevenue` does not, and
 * `orders` counts only non-cancelled postings.
 */
function windowStats(
    postings: DashboardPosting[],
    from: Date,
    to: Date
): { revenue: number; netRevenue: number; orders: number } {
    let revenue = 0;
    let netRevenue = 0;
    let orders = 0;

    for (const posting of postings) {
        const createdAt = new Date(posting.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;
        if (createdAt <= from || createdAt > to) continue;

        const total = postingTotal(posting);
        revenue += total;

        if (isCancelled(posting)) continue;
        netRevenue += total;
        orders += 1;
    }

    return { revenue, netRevenue, orders };
}

export interface PeriodDelta {
    /** Gross revenue, cancellations included. */
    revenue: number;
    previousRevenue: number;
    /** Revenue without cancelled postings — the figure the dashboard headlines. */
    netRevenue: number;
    previousNetRevenue: number;
    orders: number;
    previousOrders: number;
    /** `null` when the previous window had no revenue to compare against. */
    revenueChangePct: number | null;
    netRevenueChangePct: number | null;
    ordersChangePct: number | null;
}

export interface WindowComparisons {
    last24h: PeriodDelta;
    last7d: PeriodDelta;
}

function toDelta(
    current: { revenue: number; netRevenue: number; orders: number },
    previous: { revenue: number; netRevenue: number; orders: number }
): PeriodDelta {
    /** Percentage growth, or `null` when there is no baseline to divide by. */
    const change = (now: number, before: number) =>
        before > 0 ? ((now - before) / before) * 100 : null;

    return {
        revenue: current.revenue,
        previousRevenue: previous.revenue,
        netRevenue: current.netRevenue,
        previousNetRevenue: previous.netRevenue,
        orders: current.orders,
        previousOrders: previous.orders,
        revenueChangePct: change(current.revenue, previous.revenue),
        netRevenueChangePct: change(current.netRevenue, previous.netRevenue),
        ordersChangePct: change(current.orders, previous.orders)
    };
}

/**
 * Compares the trailing 24h and 7d windows with the window right before each.
 *
 * Both "previous" windows fall inside the 31 days the dashboard loads, so the
 * comparison is always backed by data. A calendar-month comparison would need a
 * wider load, which is why it is not offered here.
 *
 * These are rolling windows (`now - N days` .. `now`), not calendar ones, and they
 * report both gross and net revenue. The dashboard headlines the net figures so a
 * delta always compares like with like: the hero card and the trend chart are net
 * too.
 */
export function compareWindows(
    postings: DashboardPosting[],
    now = new Date()
): WindowComparisons {
    const ms = now.getTime();

    return {
        last24h: toDelta(
            windowStats(postings, new Date(ms - DAY), now),
            windowStats(postings, new Date(ms - 2 * DAY), new Date(ms - DAY))
        ),
        last7d: toDelta(
            windowStats(postings, new Date(ms - 7 * DAY), now),
            windowStats(postings, new Date(ms - 14 * DAY), new Date(ms - 7 * DAY))
        )
    };
}

export interface TrendPoint {
    /** Local date, `YYYY-MM-DD`. */
    date: string;
    /** Gross revenue, cancellations included. */
    revenue: number;
    /** Revenue without cancelled postings. */
    netRevenue: number;
    orders: number;
    units: number;
}

/** One point per day over the trailing `days`, oldest first. */
export function dailyTrend(
    postings: DashboardPosting[],
    days = 14,
    now = new Date()
): TrendPoint[] {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const byDate = new Map<string, TrendPoint>();
    const points: TrendPoint[] = [];

    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(startOfToday);
        date.setDate(date.getDate() - offset);

        const point: TrendPoint = {
            date: dateKey(date),
            revenue: 0,
            netRevenue: 0,
            orders: 0,
            units: 0
        };
        points.push(point);
        byDate.set(point.date, point);
    }

    for (const posting of postings) {
        const createdAt = new Date(posting.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;

        const point = byDate.get(dateKey(createdAt));
        if (!point) continue;

        const total = postingTotal(posting);
        point.revenue += total;

        if (!isCancelled(posting)) {
            point.netRevenue += total;
            point.orders += 1;
            point.units += postingUnits(posting);
        }
    }

    return points;
}

export interface ProductAggregate {
    sku: number;
    /** Ozon article (`offer_id`), which is what usually names the exact design. */
    offerId: string;
    name: string;
    revenue: number;
    units: number;
    orders: number;
}

/** Per-SKU totals, ranked by revenue. Cancelled postings are excluded. */
export function topProducts(
    postings: DashboardPosting[],
    limit = 10
): ProductAggregate[] {
    const bySku = new Map<number, ProductAggregate>();

    for (const posting of postings) {
        if (isCancelled(posting)) continue;

        for (const product of posting.products ?? []) {
            const entry =
                bySku.get(product.sku) ??
                ({
                    sku: product.sku,
                    offerId: product.offer_id,
                    name: product.name || product.offer_id,
                    revenue: 0,
                    units: 0,
                    orders: 0
                } satisfies ProductAggregate);

            entry.revenue += productUnitPrice(product) * (product.quantity || 1);
            entry.units += product.quantity || 1;
            entry.orders += 1;
            if (!entry.offerId && product.offer_id) entry.offerId = product.offer_id;
            if (!entry.name && (product.name || product.offer_id)) {
                entry.name = product.name || product.offer_id;
            }

            bySku.set(product.sku, entry);
        }
    }

    return [...bySku.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

export interface RevenueConcentration {
    total: number;
    skuCount: number;
    topCount: number;
    /** Share of revenue earned by the best `topPercent` of SKUs, in percent. */
    topShare: number;
}

/**
 * Pareto view of the assortment: how much revenue the top slice of SKUs brings.
 * A high share means the business leans on a few products.
 */
export function revenueConcentration(
    postings: DashboardPosting[],
    topPercent = 0.2
): RevenueConcentration {
    const products = topProducts(postings, Number.MAX_SAFE_INTEGER);
    const total = products.reduce((sum, product) => sum + product.revenue, 0);
    const skuCount = products.length;

    if (skuCount === 0 || total <= 0) {
        return { total, skuCount, topCount: 0, topShare: 0 };
    }

    const topCount = Math.max(1, Math.ceil(skuCount * topPercent));
    const topRevenue = products
        .slice(0, topCount)
        .reduce((sum, product) => sum + product.revenue, 0);

    return { total, skuCount, topCount, topShare: (topRevenue / total) * 100 };
}

export interface NamedAggregate {
    name: string;
    revenue: number;
    orders: number;
    units: number;
    /** Share of revenue, in percent. */
    share: number;
}

function aggregateBy(
    postings: DashboardPosting[],
    pick: (posting: DashboardPosting) => string | undefined,
    limit: number
): NamedAggregate[] {
    const byName = new Map<string, NamedAggregate>();
    let totalRevenue = 0;

    for (const posting of postings) {
        if (isCancelled(posting)) continue;

        const name = pick(posting)?.trim() || 'Не указано';
        const revenue = postingTotal(posting);
        totalRevenue += revenue;

        const entry =
            byName.get(name) ??
            ({ name, revenue: 0, orders: 0, units: 0, share: 0 } satisfies NamedAggregate);
        entry.revenue += revenue;
        entry.orders += 1;
        entry.units += postingUnits(posting);

        byName.set(name, entry);
    }

    return [...byName.values()]
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, limit)
        .map((entry) => ({
            ...entry,
            share: totalRevenue > 0 ? (entry.revenue / totalRevenue) * 100 : 0
        }));
}

/** Revenue by delivery city (`analytics_data.city`). */
export function byCity(postings: DashboardPosting[], limit = 8): NamedAggregate[] {
    return aggregateBy(postings, (posting) => posting.analytics_data?.city, limit);
}

/** Revenue by payment group (`analytics_data.payment_type_group_name`). */
export function byPaymentType(postings: DashboardPosting[], limit = 8): NamedAggregate[] {
    return aggregateBy(
        postings,
        (posting) => posting.analytics_data?.payment_type_group_name,
        limit
    );
}

export interface RouteAggregate {
    from: string;
    to: string;
    orders: number;
    revenue: number;
}

/** Orders grouped by cluster route `cluster_from → cluster_to`. */
export function clusterRoutes(postings: DashboardPosting[], limit = 6): RouteAggregate[] {
    const byRoute = new Map<string, RouteAggregate>();

    for (const posting of postings) {
        if (isCancelled(posting)) continue;

        const from = posting.financial_data?.cluster_from || '—';
        const to = posting.financial_data?.cluster_to || '—';
        const entry =
            byRoute.get(`${from}→${to}`) ??
            ({ from, to, orders: 0, revenue: 0 } satisfies RouteAggregate);

        entry.orders += 1;
        entry.revenue += postingTotal(posting);

        byRoute.set(`${from}→${to}`, entry);
    }

    return [...byRoute.values()].sort((a, b) => b.orders - a.orders).slice(0, limit);
}

export interface ActionAggregate {
    action: string;
    orders: number;
    revenue: number;
}

/** Orders grouped by the flattened `actions` tags on their products. */
export function actionBreakdown(
    postings: DashboardPosting[],
    limit = 8
): ActionAggregate[] {
    const byAction = new Map<string, ActionAggregate>();

    for (const posting of postings) {
        if (isCancelled(posting)) continue;

        for (const action of posting.actions ?? []) {
            const entry =
                byAction.get(action) ??
                ({ action, orders: 0, revenue: 0 } satisfies ActionAggregate);

            entry.orders += 1;
            entry.revenue += postingTotal(posting);

            byAction.set(action, entry);
        }
    }

    return [...byAction.values()].sort((a, b) => b.orders - a.orders).slice(0, limit);
}

export interface PromoShare {
    promoOrders: number;
    organicOrders: number;
    promoRevenue: number;
    organicRevenue: number;
    /** Share of orders carrying at least one action tag, in percent. */
    promoShare: number;
}

/** Splits orders into those carrying action tags and the rest. */
export function promoShare(postings: DashboardPosting[]): PromoShare {
    let promoOrders = 0;
    let organicOrders = 0;
    let promoRevenue = 0;
    let organicRevenue = 0;

    for (const posting of postings) {
        if (isCancelled(posting)) continue;

        const revenue = postingTotal(posting);
        if ((posting.actions?.length ?? 0) > 0) {
            promoOrders += 1;
            promoRevenue += revenue;
        } else {
            organicOrders += 1;
            organicRevenue += revenue;
        }
    }

    const total = promoOrders + organicOrders;
    return {
        promoOrders,
        organicOrders,
        promoRevenue,
        organicRevenue,
        promoShare: total > 0 ? (promoOrders / total) * 100 : 0
    };
}

export interface HourPoint {
    /** Local hour of the day, 0–23. */
    hour: number;
    orders: number;
    revenue: number;
    units: number;
}

/**
 * Orders grouped by the local hour of the day over the trailing `days`.
 * Answers the "when do customers buy" question; cancellations are excluded.
 * Hours are read in the browser's timezone, i.e. the seller's own clock.
 */
export function hourlyActivity(
    postings: DashboardPosting[],
    days = 14,
    now = new Date()
): HourPoint[] {
    const since = new Date(now.getTime() - days * DAY);
    const buckets: HourPoint[] = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        orders: 0,
        revenue: 0,
        units: 0
    }));

    for (const posting of postings) {
        if (isCancelled(posting)) continue;

        const createdAt = new Date(posting.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;
        if (createdAt < since || createdAt > now) continue;

        const bucket = buckets[createdAt.getHours()];
        bucket.orders += 1;
        bucket.revenue += postingTotal(posting);
        bucket.units += postingUnits(posting);
    }

    return buckets;
}

/** Human labels for the Ozon posting statuses the dashboard shows. */
export const STATUS_LABELS: Record<string, string> = {
    awaiting_packaging: 'Ожидает упаковки',
    awaiting_deliver: 'Ожидает отгрузки',
    delivering: 'В доставке',
    delivered: 'Доставлен',
    cancelled: 'Отменён'
};

const STATUS_ORDER = Object.keys(STATUS_LABELS);

export interface StatusRow {
    status: string;
    /** Counts aligned with `StatusBreakdown.windows`. */
    counts: number[];
}

export interface StatusBreakdown {
    /** Windows in days, ascending. */
    windows: number[];
    rows: StatusRow[];
    /** Total postings per window, aligned with `windows`. */
    totals: number[];
}

/**
 * Posting counts per status for several nested windows (7/14/31 days by default).
 *
 * Every posting counts in each window it falls into — cancellations included —
 * so the figures answer "how many orders of each status came in over the window".
 * `now` is injectable to keep results deterministic in tests.
 */
export function statusBreakdown(
    postings: DashboardPosting[],
    windows: number[] = [7, 14, 31],
    now = new Date()
): StatusBreakdown {
    const byStatus = new Map<string, number[]>();
    const totals = windows.map(() => 0);

    for (const posting of postings) {
        const createdAt = new Date(posting.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;

        const ageDays = (now.getTime() - createdAt.getTime()) / DAY;
        if (ageDays < 0) continue;

        const counts = byStatus.get(posting.status) ?? windows.map(() => 0);

        for (let index = 0; index < windows.length; index += 1) {
            if (ageDays <= windows[index]) {
                counts[index] += 1;
                totals[index] += 1;
            }
        }

        byStatus.set(posting.status, counts);
    }

    const rows: StatusRow[] = [...byStatus.entries()].map(([status, counts]) => ({
        status,
        counts
    }));

    rows.sort((a, b) => {
        const rankA = STATUS_ORDER.indexOf(a.status);
        const rankB = STATUS_ORDER.indexOf(b.status);

        if (rankA !== -1 || rankB !== -1) {
            if (rankA === -1) return 1;
            if (rankB === -1) return -1;
            return rankA - rankB;
        }

        return (b.counts.at(-1) ?? 0) - (a.counts.at(-1) ?? 0);
    });

    return { windows, rows, totals };
}
