import { describe, expect, it } from 'vitest';
import {
    collectFees,
    readAmount,
    summariseDay,
    toAccrual,
    toTypeCatalogue
} from './accruals';

describe('readAmount', () => {
    it('reads a plain number', () => {
        expect(readAmount(1400.5)).toBe(1400.5);
    });

    it('reads a nested amount object, which is the documented shape', () => {
        expect(readAmount({ amount: 306.5, currency: 'RUB' })).toBe(306.5);
    });

    it('reads a numeric string, including comma decimals and spaces', () => {
        expect(readAmount('1 234,56')).toBe(1234.56);
        expect(readAmount('99')).toBe(99);
    });

    it('returns null instead of zero when there is nothing to read', () => {
        // The distinction matters: an unread amount must not become a zero.
        expect(readAmount(undefined)).toBeNull();
        expect(readAmount(null)).toBeNull();
        expect(readAmount('abc')).toBeNull();
        expect(readAmount({})).toBeNull();
        expect(readAmount(Number.NaN)).toBeNull();
    });

    it('keeps a genuine zero', () => {
        expect(readAmount(0)).toBe(0);
        expect(readAmount({ amount: 0 })).toBe(0);
    });
});

describe('collectFees', () => {
    it('finds a fee under a posting product delivery block', () => {
        const fees = collectFees({
            posting: {
                products: [
                    { delivery: { services: [{ type_id: 301, accrued: { amount: -103 } }] } }
                ]
            }
        });

        expect(fees).toEqual([{ typeId: '301', amount: -103 }]);
    });

    it('finds the doubly nested item fees, where acquiring hides', () => {
        const fees = collectFees({
            item_fees: { fees: [{ fees: [{ type_id: 1100, accrued: { amount: -7.02 } }] }] }
        });

        expect(fees).toEqual([{ typeId: '1100', amount: -7.02 }]);
    });

    it('finds the flat non-item blocks', () => {
        const fees = collectFees({
            non_item_fee: { type_id: '500', accrued: { amount: -2100 } },
            container_fees: [{ type_id: '501', accrued: { amount: -15 } }]
        });

        expect(fees).toEqual([
            { typeId: '500', amount: -2100 },
            { typeId: '501', amount: -15 }
        ]);
    });

    it('stops at a recognised pair so a fee is never counted twice', () => {
        const fees = collectFees({
            type_id: '1',
            accrued: { amount: -10, nested: { type_id: '2', accrued: { amount: -20 } } }
        });

        expect(fees).toEqual([{ typeId: '1', amount: -10 }]);
    });

    it('skips a type_id that has no readable accrued value', () => {
        const fees = collectFees({ type_id: '1', accrued: 'not a number', other: { type_id: '2', accrued: 5 } });

        expect(fees).toEqual([{ typeId: '2', amount: 5 }]);
    });

    it('is safe on an empty or primitive payload', () => {
        expect(collectFees(null)).toEqual([]);
        expect(collectFees('text')).toEqual([]);
        expect(collectFees({})).toEqual([]);
    });

    it('does not hang on a deeply nested payload', () => {
        let node: Record<string, unknown> = { type_id: '999', accrued: 1 };
        for (let i = 0; i < 40; i += 1) node = { nested: node };

        expect(collectFees(node)).toEqual([]);
    });
});

describe('toAccrual', () => {
    it('maps the fields the old API called something else', () => {
        const accrual = toAccrual({
            accrual_id: '11401182187840',
            date: '2026-09-15',
            accrued_category: 'POSTING',
            unit_number: '0208194185-0001-1',
            total_amount: { amount: 299.48, currency: 'RUB' }
        });

        expect(accrual).toMatchObject({
            id: '11401182187840',
            date: '2026-09-15',
            category: 'POSTING',
            postingNumber: '0208194185-0001-1',
            amount: 299.48
        });
    });

    it('falls back to operation_id, so history stays contiguous after the migration', () => {
        const accrual = toAccrual({
            operation_id: '42',
            date: '2026-08-20',
            total_amount: 10
        });

        expect(accrual?.id).toBe('42');
    });

    it('accepts posting_number as well as unit_number', () => {
        const accrual = toAccrual({
            accrual_id: '1',
            date: '2026-09-15',
            posting_number: 'X-1',
            total_amount: 5
        });

        expect(accrual?.postingNumber).toBe('X-1');
    });

    it('leaves the posting empty for a cabinet-level cost', () => {
        const accrual = toAccrual({
            accrual_id: '2',
            date: '2026-09-15',
            accrued_category: 'NON_ITEM',
            total_amount: { amount: -2100 }
        });

        expect(accrual?.postingNumber).toBeNull();
    });

    it('marks an unrecognised category rather than guessing one', () => {
        const accrual = toAccrual({ accrual_id: '3', date: '2026-09-15', total_amount: 1 });

        expect(accrual?.category).toBe('UNKNOWN');
    });

    it('takes the seller price from the posting block when present', () => {
        const accrual = toAccrual({
            accrual_id: '1',
            date: '2026-09-15',
            total_amount: 299.48,
            posting: { seller_price: { amount: 790 } }
        });

        expect(accrual?.gross).toBe(790);
    });

    it('drops a row with no readable total, instead of inventing a zero', () => {
        expect(toAccrual({ accrual_id: '1', date: '2026-09-15' })).toBeNull();
        expect(toAccrual(null)).toBeNull();
    });

    it('never recomputes the amount from its parts', () => {
        // A fine carries no fees at all; the total is still the truth.
        const accrual = toAccrual({
            accrual_id: '9',
            date: '2026-09-15',
            total_amount: { amount: -500 },
            penalty: { type_id: '900', accrued: { amount: -500 } }
        });

        expect(accrual?.amount).toBe(-500);
        expect(accrual?.fees).toEqual([{ typeId: '900', amount: -500 }]);
    });
});

describe('summariseDay', () => {
    const accrual = (over: Partial<Parameters<typeof summariseDay>[1][number]>) => ({
        id: 'a',
        date: '2026-09-15',
        category: 'POSTING' as const,
        postingNumber: 'P-1',
        amount: 100,
        gross: 200,
        commission: null,
        fees: [],
        ...over
    });

    it('totals the day and splits it by category', () => {
        const summary = summariseDay('2026-09-15', [
            accrual({}),
            accrual({ id: 'b', category: 'ITEM', amount: -7, fees: [{ typeId: '1100', amount: -7 }] })
        ]);

        expect(summary.status).toBe('ok');
        expect(summary.net).toBe(93);
        expect(summary.gross).toBe(400);
        expect(summary.byCategory).toEqual({ POSTING: 100, ITEM: -7 });
        expect(summary.byType).toEqual({ 1100: -7 });
        expect(summary.counts).toEqual({ total: 2, withPosting: 2, cabinet: 0 });
    });

    it('reports a day with no accruals as empty, not as failed', () => {
        const summary = summariseDay('2026-09-15', []);

        expect(summary.status).toBe('empty');
        expect(summary.net).toBe(0);
    });

    it('keeps cabinet costs out of the per-posting figures', () => {
        const summary = summariseDay('2026-09-15', [
            accrual({}),
            accrual({
                id: 'c',
                category: 'NON_ITEM',
                postingNumber: null,
                amount: -2100,
                fees: [{ typeId: '500', amount: -2100 }]
            })
        ]);

        expect(summary.counts).toEqual({ total: 2, withPosting: 1, cabinet: 1 });
        expect(summary.cabinetByType).toEqual({ total: -2100, 500: -2100 });
        // The cabinet cost is still part of the day's net; it is only attributed apart.
        expect(summary.net).toBe(-2000);
    });

    it('keeps per-posting detail only when asked, to bound the payload', () => {
        const withDetail = summariseDay('2026-09-15', [accrual({})], true);
        const without = summariseDay('2026-09-15', [accrual({})], false);

        expect(withDetail.byPosting).toEqual({ 'P-1': 100 });
        expect(without.byPosting).toBeUndefined();
    });

    it('accumulates several accruals of one posting', () => {
        const summary = summariseDay(
            '2026-09-15',
            [accrual({ amount: 306.5 }), accrual({ id: 'b', category: 'ITEM', amount: -7.02 })],
            true
        );

        expect(summary.byPosting).toEqual({ 'P-1': 299.48 });
    });

    it('does not derive the net from the fee lines', () => {
        // Fees here sum to -100 while the accrual says +50: the total wins.
        const summary = summariseDay('2026-09-15', [
            accrual({ amount: 50, fees: [{ typeId: 'x', amount: -100 }] })
        ]);

        expect(summary.net).toBe(50);
        expect(summary.byType).toEqual({ x: -100 });
    });
});

describe('toTypeCatalogue', () => {
    it('reads the flat envelope', () => {
        expect(toTypeCatalogue({ types: [{ id: 301, name: 'Логистика' }] })).toEqual({
            301: 'Логистика'
        });
    });

    it('reads the enveloped variant', () => {
        expect(toTypeCatalogue({ result: { types: [{ id: '1100', name: 'Эквайринг' }] } })).toEqual({
            1100: 'Эквайринг'
        });
    });

    it('skips entries without an id or a name, and tolerates junk', () => {
        expect(
            toTypeCatalogue({ types: [{ id: 1 }, { name: 'no id' }, { id: 2, name: 'ok' }, null] })
        ).toEqual({ 2: 'ok' });
        expect(toTypeCatalogue(null)).toEqual({});
        expect(toTypeCatalogue({})).toEqual({});
    });
});
