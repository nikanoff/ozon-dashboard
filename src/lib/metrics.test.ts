import { describe, expect, it } from 'vitest';
import {
    actionBreakdown,
    byCity,
    byPaymentType,
    clusterRoutes,
    compareWindows,
    dailyTrend,
    hourlyActivity,
    promoShare,
    revenueConcentration,
    statusBreakdown,
    topProducts
} from './metrics';
import type { DashboardPosting } from './ozon_types';

/** Wednesday, 16 September 2026, local noon. */
const NOW = new Date(2026, 8, 16, 12, 0, 0);

const HOUR = 60 * 60 * 1000;

function posting(overrides: Partial<DashboardPosting> = {}): DashboardPosting {
    return {
        posting_number: '1-1',
        status: 'delivered',
        created_at: NOW.toISOString(),
        products: [
            { offer_id: 'offer', sku: 1, quantity: 1, price: { amount: '100', currency: 'RUB' } }
        ],
        financial_products: [],
        actions: [],
        ...overrides
    };
}

/** A posting created `hoursAgo` before `NOW`. */
function hoursAgo(hours: number, overrides: Partial<DashboardPosting> = {}): DashboardPosting {
    return posting({ created_at: new Date(NOW.getTime() - hours * HOUR).toISOString(), ...overrides });
}

/** A posting created `days` before `NOW`. */
function daysAgo(days: number, overrides: Partial<DashboardPosting> = {}): DashboardPosting {
    return posting({ created_at: new Date(NOW.getTime() - days * 24 * HOUR).toISOString(), ...overrides });
}

describe('dailyTrend', () => {
    it('returns one bucket per day, oldest first', () => {
        const trend = dailyTrend([], 3, NOW);

        expect(trend).toHaveLength(3);
        expect(trend.map((point) => point.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    });

    it('places a posting in its local day and excludes cancellations from net', () => {
        const trend = dailyTrend(
            [posting(), posting({ status: 'cancelled' })],
            2,
            NOW
        );
        const today = trend.at(-1)!;

        expect(today.revenue).toBe(200);
        expect(today.netRevenue).toBe(100);
        expect(today.orders).toBe(1);
        expect(today.units).toBe(1);
    });
});

describe('topProducts', () => {
    it('ranks SKUs by revenue and ignores cancellations', () => {
        const top = topProducts([
            posting({
                products: [{ offer_id: 'a', sku: 1, quantity: 2, price: { amount: '100', currency: 'RUB' } }]
            }),
            posting({
                products: [{ offer_id: 'b', sku: 2, quantity: 1, price: { amount: '500', currency: 'RUB' } }]
            }),
            posting({
                status: 'cancelled',
                products: [{ offer_id: 'c', sku: 3, quantity: 10, price: { amount: '999', currency: 'RUB' } }]
            })
        ]);

        expect(top.map((product) => product.sku)).toEqual([2, 1]);
        expect(top[0]).toMatchObject({ offerId: 'b', revenue: 500 });
        expect(top[1]).toMatchObject({ offerId: 'a', revenue: 200, units: 2, orders: 1 });
    });
});

describe('revenueConcentration', () => {
    it('reports the revenue share of the top 20% of SKUs', () => {
        const postings = [1, 2, 3, 4, 5].map((sku, index) =>
            posting({
                products: [{ offer_id: `o${sku}`, sku, quantity: 1, price: { amount: String((5 - index) * 100), currency: 'RUB' } }]
            })
        );

        const concentration = revenueConcentration(postings);

        // Five SKUs, so the top 20% is one SKU: the best seller carries 500/1500.
        expect(concentration.skuCount).toBe(5);
        expect(concentration.topCount).toBe(1);
        expect(concentration.topShare).toBeCloseTo(33.33, 1);
    });

    it('is empty-safe', () => {
        expect(revenueConcentration([])).toEqual({ total: 0, skuCount: 0, topCount: 0, topShare: 0 });
    });
});

describe('grouped breakdowns', () => {
    it('aggregates revenue by city with shares', () => {
        const cities = byCity([
            posting({ analytics_data: { city: 'Москва' } }),
            posting({ analytics_data: { city: 'Москва' } }),
            posting({ analytics_data: { city: 'Казань' } })
        ]);

        expect(cities[0]).toMatchObject({ name: 'Москва', revenue: 200, orders: 2 });
        expect(cities[0].share).toBeCloseTo(66.67, 1);
        expect(cities[1]).toMatchObject({ name: 'Казань', revenue: 100 });
    });

    it('groups postings without a payment type under a placeholder', () => {
        const payments = byPaymentType([posting(), posting({ analytics_data: { payment_type_group_name: 'Ozon Банк' } })]);

        expect(payments.map((entry) => entry.name)).toEqual(['Не указано', 'Ozon Банк']);
    });

    it('ranks cluster routes by order count', () => {
        const routes = clusterRoutes([
            posting({ financial_data: { cluster_from: 'A', cluster_to: 'B' } }),
            posting({ financial_data: { cluster_from: 'A', cluster_to: 'B' } }),
            posting({ financial_data: { cluster_from: 'A', cluster_to: 'C' } })
        ]);

        expect(routes[0]).toMatchObject({ from: 'A', to: 'B', orders: 2 });
    });
});

describe('actions', () => {
    it('counts orders per action tag', () => {
        const actions = actionBreakdown([
            posting({ actions: ['Акция', 'Скидка'] }),
            posting({ actions: ['Акция'] })
        ]);

        expect(actions).toEqual([
            { action: 'Акция', orders: 2, revenue: 200 },
            { action: 'Скидка', orders: 1, revenue: 100 }
        ]);
    });

    it('splits orders carrying tags from the rest', () => {
        const share = promoShare([posting({ actions: ['Акция'] }), posting()]);

        expect(share).toMatchObject({
            promoOrders: 1,
            organicOrders: 1,
            promoRevenue: 100,
            organicRevenue: 100
        });
        expect(share.promoShare).toBeCloseTo(50);
    });
});

describe('hourlyActivity', () => {
    it('returns 24 buckets and places orders in their local hour', () => {
        const buckets = hourlyActivity(
            [
                posting({ created_at: new Date(2026, 8, 15, 19, 30).toISOString() }),
                posting({ created_at: new Date(2026, 8, 15, 19, 5).toISOString() }),
                posting({ created_at: new Date(2026, 8, 16, 9, 0).toISOString() }),
                posting({
                    status: 'cancelled',
                    created_at: new Date(2026, 8, 15, 19, 0).toISOString()
                })
            ],
            14,
            NOW
        );

        expect(buckets).toHaveLength(24);
        expect(buckets[19]).toMatchObject({ hour: 19, orders: 2, revenue: 200 });
        expect(buckets[9].orders).toBe(1);
        expect(buckets[0].orders).toBe(0);
    });

    it('ignores postings outside the window', () => {
        const buckets = hourlyActivity(
            [posting({ created_at: new Date(2026, 6, 1, 12, 0).toISOString() })],
            14,
            NOW
        );

        expect(buckets.reduce((sum, bucket) => sum + bucket.orders, 0)).toBe(0);
    });
});

describe('statusBreakdown', () => {
    it('counts each posting in every window it falls into', () => {
        const result = statusBreakdown(
            [
                daysAgo(1, { status: 'delivering' }),
                daysAgo(5, { status: 'delivered' }),
                daysAgo(10, { status: 'delivered' }),
                daysAgo(20, { status: 'cancelled' })
            ],
            [7, 14, 31],
            NOW
        );

        expect(result.totals).toEqual([2, 3, 4]);
        expect(result.rows.find((row) => row.status === 'delivered')?.counts).toEqual([1, 2, 2]);
        expect(result.rows.find((row) => row.status === 'cancelled')?.counts).toEqual([0, 0, 1]);
    });

    it('lists known statuses first and unknown ones after', () => {
        const result = statusBreakdown(
            [daysAgo(1, { status: 'something_new' }), daysAgo(1, { status: 'cancelled' })],
            [7],
            NOW
        );

        expect(result.rows.map((row) => row.status)).toEqual(['cancelled', 'something_new']);
    });

    it('ignores postings dated in the future', () => {
        const result = statusBreakdown(
            [posting({ created_at: new Date(NOW.getTime() + 2 * HOUR).toISOString() })],
            [7, 14, 31],
            NOW
        );

        expect(result.totals).toEqual([0, 0, 0]);
        expect(result.rows).toEqual([]);
    });
});

describe('compareWindows', () => {
    it('compares the trailing window with the one before it', () => {
        const comparison = compareWindows(
            [
                hoursAgo(2, { products: [{ offer_id: 'a', sku: 1, quantity: 1, price: { amount: '200', currency: 'RUB' } }] }),
                hoursAgo(30)
            ],
            NOW
        );

        expect(comparison.last24h.revenue).toBe(200);
        expect(comparison.last24h.previousRevenue).toBe(100);
        expect(comparison.last24h.revenueChangePct).toBeCloseTo(100);
    });

    it('returns null change when the previous window was empty', () => {
        const comparison = compareWindows([hoursAgo(2)], NOW);

        expect(comparison.last7d.previousRevenue).toBe(0);
        expect(comparison.last7d.revenueChangePct).toBeNull();
    });

    it('reports net revenue next to gross so both readings are available', () => {
        const comparison = compareWindows(
            [
                hoursAgo(2),
                hoursAgo(3, { status: 'cancelled' })
            ],
            NOW
        );

        // Gross keeps the cancelled posting, net drops it.
        expect(comparison.last24h.revenue).toBe(200);
        expect(comparison.last24h.netRevenue).toBe(100);
        expect(comparison.last24h.orders).toBe(1);
    });

    it('never counts one posting in two adjacent windows', () => {
        // Exactly on the shared boundary of the current and previous 24h windows.
        const onBoundary = new Date(NOW.getTime() - 24 * HOUR);

        const comparison = compareWindows([{ ...posting(), created_at: onBoundary.toISOString() }], NOW);

        expect(comparison.last24h.previousRevenue).toBe(100);
        expect(comparison.last24h.revenue).toBe(0);
    });

    it('derives the net change from the previous net revenue', () => {
        const comparison = compareWindows(
            [
                hoursAgo(2, { products: [{ offer_id: 'a', sku: 1, quantity: 1, price: { amount: '300', currency: 'RUB' } }] }),
                // Previous window: 100 net plus a cancellation that must not count.
                hoursAgo(30),
                hoursAgo(31, { status: 'cancelled' })
            ],
            NOW
        );

        expect(comparison.last24h.previousNetRevenue).toBe(100);
        expect(comparison.last24h.netRevenueChangePct).toBeCloseTo(200);
    });
});
