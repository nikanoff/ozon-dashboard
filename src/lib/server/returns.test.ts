import { describe, expect, it } from 'vitest';
import { toReturn } from './returns';

/**
 * The returns feed's parsing rules, taken from live responses.
 *
 * What the live method settled, and what these tests pin down: the date lives in
 * `logistic.return_date` (the field the filter also uses), money is
 * `product.price.price` times `product.quantity`, and a record with no readable date has to
 * be dropped rather than counted into some other period.
 */
describe('toReturn', () => {
    it('reads the live shape: date, article, units, price and type', () => {
        const record = toReturn({
            id: 1002045644,
            type: 'Cancellation',
            logistic: { return_date: '2026-09-30T12:00:00.000Z' },
            visual: { status: { display_name: 'На складе Ozon' } },
            product: {
                sku: 2103351437,
                offer_id: 'picnicplaidtentinforest',
                quantity: 2,
                price: { currency_code: 'RUB', price: 1499 }
            }
        });

        expect(record?.date).toBe('2026-09-30');
        expect(record?.sku).toBe(2103351437);
        expect(record?.offerId).toBe('picnicplaidtentinforest');
        expect(record?.units).toBe(2);
        expect(record?.amount).toBe(2998);
        expect(record?.type).toBe('Cancellation');
    });

    it('dates a return by the local calendar day, the unit the cards count in', () => {
        // Both instants are built from local time, so the expected day holds in any zone:
        // an order of events a UTC slice would move to the neighbouring day.
        const lateEvening = toReturn({
            id: 1,
            logistic: { return_date: new Date(2026, 8, 30, 23, 30).toISOString() },
            product: { sku: 1, quantity: 1 }
        });
        const earlyMorning = toReturn({
            id: 2,
            logistic: { return_date: new Date(2026, 9, 1, 0, 30).toISOString() },
            product: { sku: 1, quantity: 1 }
        });

        expect(lateEvening?.date).toBe('2026-09-30');
        expect(earlyMorning?.date).toBe('2026-10-01');
    });

    it('falls back to the visual change moment when logistics has no date', () => {
        const record = toReturn({
            id: 5,
            logistic: {},
            visual: { change_moment: '2026-09-10T05:00:00.000Z' },
            product: { sku: 7, quantity: 1, price: { price: 500 } }
        });

        expect(record?.date).toBe('2026-09-10');
    });

    it('treats a missing quantity as one unit rather than as nothing', () => {
        const record = toReturn({
            id: 6,
            logistic: { return_date: '2026-09-10T05:00:00.000Z' },
            product: { sku: 7, price: { price: 500 } }
        });

        expect(record?.units).toBe(1);
        expect(record?.amount).toBe(500);
    });

    it('drops a record with no date, because it belongs to no period', () => {
        expect(
            toReturn({ id: 7, logistic: {}, visual: {}, product: { sku: 1, quantity: 1 } })
        ).toBeNull();
        expect(
            toReturn({ id: 8, logistic: { return_date: 'nonsense' }, product: { sku: 1 } })
        ).toBeNull();
    });

    it('drops a record without an identifier or a SKU', () => {
        expect(toReturn({ logistic: { return_date: '2026-09-10T05:00:00.000Z' } })).toBeNull();
        expect(
            toReturn({ id: 9, logistic: { return_date: '2026-09-10T05:00:00.000Z' }, product: {} })
        ).toBeNull();
    });

    it('survives a payload that is not an object', () => {
        expect(toReturn(null)).toBeNull();
        expect(toReturn('nonsense')).toBeNull();
        expect(toReturn(42)).toBeNull();
    });
});
