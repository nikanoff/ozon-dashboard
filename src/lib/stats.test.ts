import { describe, expect, it } from 'vitest';
import { calculateStats, isCrossCluster, postingTotal, productUnitPrice } from './stats';
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

    it('returns zeroed periods for an empty list', () => {
        const stats = calculateStats([], NOW);

        for (const value of Object.values(stats)) {
            expect(value).toEqual({ count: 0, sum: 0, cancelled: 0, cancelledSum: 0, netSum: 0, crossCluster: 0 });
        }
    });
});
