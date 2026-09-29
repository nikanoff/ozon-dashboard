import { describe, expect, it } from 'vitest';
import { inventoryInsights } from './inventory';
import type { OzonPosting, StockRow } from './ozon_types';

/** Wednesday, 16 September 2026, local noon. */
const NOW = new Date(2026, 8, 16, 12, 0, 0);
const YESTERDAY = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

function posting(sku: number, quantity: number, overrides: Partial<OzonPosting> = {}): OzonPosting {
    return {
        posting_number: `1-${sku}`,
        status: 'delivered',
        created_at: YESTERDAY,
        products: [{ offer_id: `o${sku}`, sku, quantity, price: { amount: '100', currency: 'RUB' } }],
        ...overrides
    };
}

function stockRow(sku: number, present: number, type = 'fbo', reserved = 0): StockRow {
    return {
        product_id: sku,
        offer_id: `o${sku}`,
        stocks: [{ type, present, reserved, sku }]
    };
}

describe('inventoryInsights', () => {
    const postings = [
        posting(1, 14), // 1 unit/day, 3 on hand -> critical
        posting(2, 28), // 2 units/day, no stock -> out
        posting(4, 7) // 0.5 units/day, 100 on hand -> overstock
    ];
    const stocks = [stockRow(1, 3), stockRow(3, 100), stockRow(4, 100)];

    it('computes daily demand and days of cover from both payloads', () => {
        const insights = inventoryInsights(postings, stocks, NOW);
        const bySku = new Map(insights.rows.map((row) => [row.sku, row]));

        expect(bySku.get(1)).toMatchObject({ demandPerDay: 1, daysOfCover: 3, health: 'critical' });
        expect(bySku.get(2)).toMatchObject({ demandPerDay: 2, present: 0, health: 'out' });
        expect(bySku.get(4)?.daysOfCover).toBeCloseTo(200);
        expect(bySku.get(4)?.health).toBe('overstock');
        expect(bySku.get(3)).toMatchObject({ demandPerDay: 0, health: 'dead' });
    });

    it('buckets rows by health', () => {
        const insights = inventoryInsights(postings, stocks, NOW);

        expect(insights.outOfStock.map((row) => row.sku)).toEqual([2]);
        expect(insights.critical.map((row) => row.sku)).toEqual([1]);
        expect(insights.dead.map((row) => row.sku)).toEqual([3]);
        expect(insights.overstock.map((row) => row.sku)).toEqual([4]);
    });

    it('values the stock on hand from the last unit price', () => {
        const insights = inventoryInsights(postings, stocks, NOW);

        // sku1: 3 × 100, sku3: no price, sku4: 100 × 100.
        expect(insights.inventoryValue).toBe(10300);
        expect(insights.totalPresent).toBe(203);
    });

    it('ignores cancellations and postings older than the window', () => {
        const insights = inventoryInsights(
            [
                posting(1, 14, { status: 'cancelled' }),
                posting(1, 14, { created_at: '2020-01-01T00:00:00Z' })
            ],
            [stockRow(1, 10)],
            NOW
        );

        expect(insights.rows[0].demandPerDay).toBe(0);
        expect(insights.rows[0].health).toBe('dead');
    });

    it('sums present and reserved across stock types', () => {
        const insights = inventoryInsights(
            [posting(5, 14)],
            [stockRow(5, 4, 'fbo', 1), stockRow(5, 6, 'fbs', 2)],
            NOW
        );

        expect(insights.rows[0]).toMatchObject({ present: 4, reserved: 3, total: 10 });
    });
});
