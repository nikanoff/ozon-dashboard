import { describe, expect, it } from 'vitest';
import {
    averageOrderValue,
    averageUnitPrice,
    calculateStats,
    cancellationRate,
    isCrossCluster,
    postingTotal,
    postingUnits,
    productUnitPrice,
    unitsPerOrder
} from './stats';
import type { OzonPosting } from './ozon_types';

/** Wednesday, 16 September 2026, local noon. */
const NOW = new Date(2026, 8, 16, 12, 0, 0);

function posting(overrides: Partial<OzonPosting> = {}): OzonPosting {
    return {
        posting_number: '1-1',
        status: 'delivered',
        created_at: NOW.toISOString(),
        products: [
            {
                offer_id: 'offer',
                sku: 1,
                quantity: 1,
                price: { amount: '100', currency: 'RUB' }
            }
        ],
        ...overrides
    };
}

describe('productUnitPrice', () => {
    it('reads the v3 object shape', () => {
        expect(productUnitPrice({ offer_id: 'x', sku: 1, quantity: 1, price: { amount: '1699', currency: 'RUB' } })).toBe(1699);
    });

    it('reads the legacy string shape', () => {
        expect(productUnitPrice({ offer_id: 'x', sku: 1, quantity: 1, price: '1699' })).toBe(1699);
        expect(productUnitPrice({ offer_id: 'x', sku: 1, quantity: 1, price: '1699.50' })).toBe(1699.5);
    });

    it('falls back to zero instead of NaN', () => {
        expect(productUnitPrice(undefined)).toBe(0);
        expect(productUnitPrice({ offer_id: 'x', sku: 1, quantity: 1 })).toBe(0);
        expect(productUnitPrice({ offer_id: 'x', sku: 1, quantity: 1, price: { amount: 'n/a', currency: 'RUB' } })).toBe(0);
    });
});

describe('postingTotal', () => {
    it('multiplies unit price by quantity across products', () => {
        expect(
            postingTotal(
                posting({
                    products: [
                        { offer_id: 'a', sku: 1, quantity: 2, price: { amount: '100', currency: 'RUB' } },
                        { offer_id: 'b', sku: 2, quantity: 1, price: { amount: '50', currency: 'RUB' } }
                    ]
                })
            )
        ).toBe(250);
    });

    it('falls back to a quantity of one when it is falsy', () => {
        expect(
            postingTotal(
                posting({
                    products: [{ offer_id: 'a', sku: 1, quantity: 0, price: { amount: '100', currency: 'RUB' } }]
                })
            )
        ).toBe(100);
    });
});

describe('postingUnits', () => {
    it('sums quantities and treats a missing one as a single unit', () => {
        expect(
            postingUnits(
                posting({
                    products: [
                        { offer_id: 'a', sku: 1, quantity: 2 },
                        { offer_id: 'b', sku: 2, quantity: 0 }
                    ]
                })
            )
        ).toBe(3);
    });

    it('is zero for a posting without products', () => {
        expect(postingUnits(posting({ products: [] }))).toBe(0);
    });
});


describe('isCrossCluster', () => {
    it('is false for the same cluster', () => {
        expect(isCrossCluster(posting({ financial_data: { cluster_from: 'Yaroslavl`', cluster_to: 'Yaroslavl`' } }))).toBe(false);
    });

    it('is true when the clusters differ', () => {
        expect(isCrossCluster(posting({ financial_data: { cluster_from: 'Yaroslavl`', cluster_to: 'Moscow' } }))).toBe(true);
    });

    it('is false when the data is missing', () => {
        expect(isCrossCluster(posting())).toBe(false);
    });
});

describe('calculateStats', () => {
    it('counts a fresh posting in every period', () => {
        const stats = calculateStats([posting()], NOW);

        for (const key of ['last24h', 'last7d', 'last31d', 'calendarDay', 'calendarWeek', 'calendarMonth'] as const) {
            expect(stats[key]).toMatchObject({ count: 1, sum: 100, netSum: 100, cancelled: 0 });
        }
    });

    it('keeps cancellations out of the order count but in the gross sum', () => {
        const stats = calculateStats([posting(), posting({ status: 'cancelled' })], NOW);

        expect(stats.calendarDay).toMatchObject({
            count: 1,
            sum: 200,
            cancelled: 1,
            cancelledSum: 100,
            netSum: 100
        });
    });

    it('drops postings that fall outside the short windows', () => {
        const tenDaysAgo = posting({ created_at: new Date(2026, 8, 6, 12, 0, 0).toISOString() });
        const stats = calculateStats([tenDaysAgo], NOW);

        expect(stats.last24h.count).toBe(0);
        expect(stats.last7d.count).toBe(0);
        expect(stats.calendarDay.count).toBe(0);
        expect(stats.calendarWeek.count).toBe(0);
        // Still inside the 31-day window and the calendar month.
        expect(stats.last31d.count).toBe(1);
        expect(stats.calendarMonth.count).toBe(1);
    });

    it('starts the week on Monday', () => {
        const sunday = posting({ created_at: new Date(2026, 8, 13, 12, 0, 0).toISOString() });
        const stats = calculateStats([sunday], NOW);

        expect(stats.calendarWeek.count).toBe(0);
        expect(stats.last7d.count).toBe(1);
        expect(stats.calendarMonth.count).toBe(1);
    });

    it('counts cross-cluster postings', () => {
        const stats = calculateStats(
            [posting({ financial_data: { cluster_from: 'A', cluster_to: 'B' } })],
            NOW
        );

        expect(stats.calendarDay.crossCluster).toBe(1);
        expect(stats.last24h.crossCluster).toBe(1);
    });

    it('ignores postings with an unparsable date', () => {
        const stats = calculateStats([posting({ created_at: 'not a date' })], NOW);

        expect(stats.last31d.count).toBe(0);
        expect(stats.last31d.sum).toBe(0);
    });

    it('counts units and groups postings by status', () => {
        const stats = calculateStats(
            [
                posting({
                    products: [{ offer_id: 'a', sku: 1, quantity: 3, price: { amount: '50', currency: 'RUB' } }]
                }),
                posting({ status: 'cancelled' }),
                posting({ status: 'delivering' })
            ],
            NOW
        );

        expect(stats.calendarDay).toMatchObject({
            count: 2,
            units: 3 + 1 + 1,
            netUnits: 3 + 1,
            cancelledUnits: 1
        });
        expect(stats.calendarDay.byStatus).toEqual({
            delivered: 1,
            cancelled: 1,
            delivering: 1
        });
    });

    it('returns zeroed periods for an empty list', () => {
        const stats = calculateStats([], NOW);

        for (const value of Object.values(stats)) {
            expect(value).toEqual({
                count: 0,
                sum: 0,
                cancelled: 0,
                cancelledSum: 0,
                netSum: 0,
                crossCluster: 0,
                units: 0,
                cancelledUnits: 0,
                netUnits: 0,
                byStatus: {}
            });
        }
    });
});

describe('derived period metrics', () => {
    it('derives AOV, cancellation rate, units per order and average price', () => {
        const stats = calculateStats(
            [
                posting({ products: [{ offer_id: 'a', sku: 1, quantity: 2, price: { amount: '100', currency: 'RUB' } }] }),
                posting({ status: 'cancelled' })
            ],
            NOW
        );
        const period = stats.calendarDay;

        // 200 net revenue over one order, 2 units sold, one of two postings cancelled.
        expect(averageOrderValue(period)).toBe(200);
        expect(unitsPerOrder(period)).toBe(2);
        expect(averageUnitPrice(period)).toBe(100);
        expect(cancellationRate(period)).toBeCloseTo(50);
    });

    it('returns zeroes instead of dividing by zero', () => {
        const period = calculateStats([], NOW).calendarMonth;

        expect(averageOrderValue(period)).toBe(0);
        expect(unitsPerOrder(period)).toBe(0);
        expect(averageUnitPrice(period)).toBe(0);
        expect(cancellationRate(period)).toBe(0);
    });
});
