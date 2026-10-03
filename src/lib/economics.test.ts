import { describe, expect, it } from 'vitest';
import {
    abcAnalysis,
    breakEvenPrice,
    commissionSpread,
    costBookLookup,
    costKey,
    enrichLines,
    lossMaking,
    moneySummary,
    skuEconomics
} from './economics';
import { setCost } from './costs';
import type { DashboardPosting } from './ozon_types';

/** A posting with one line priced 1000 and the given financial row. */
function posting(
    money?: Partial<DashboardPosting['financial_products'][number]>,
    overrides: Partial<DashboardPosting> = {}
): DashboardPosting {
    return {
        posting_number: '1-1',
        status: 'delivered',
        created_at: '2026-09-16T09:00:00Z',
        products: [
            {
                offer_id: 'ART-1',
                name: 'Товар',
                sku: 10,
                quantity: 2,
                price: { amount: '1000', currency: 'RUB' }
            }
        ],
        financial_products: money === undefined ? [] : [money],
        actions: [],
        ...overrides
    };
}

describe('enrichLines', () => {
    it('pairs by position when both arrays are the same length', () => {
        const lines = enrichLines(posting({ payout: 1400, commission_amount: 600 }));

        expect(lines).toHaveLength(1);
        expect(lines[0].gross).toBe(2000);
        expect(lines[0].payout).toBe(1400);
        expect(lines[0].commission).toBe(600);
    });

    it('leaves money unknown rather than zero when Ozon reported nothing', () => {
        const lines = enrichLines(posting());

        expect(lines[0].gross).toBe(2000);
        expect(lines[0].payout).toBeNull();
        expect(lines[0].commission).toBeNull();
    });

    it('matches on product_id when the arrays differ in length', () => {
        const lines = enrichLines({
            ...posting(),
            products: [
                { offer_id: 'A', sku: 10, quantity: 1, price: { amount: '500', currency: 'RUB' } },
                { offer_id: 'B', sku: 20, quantity: 1, price: { amount: '700', currency: 'RUB' } }
            ],
            financial_products: [{ product_id: 20, payout: 600, commission_amount: 100 }]
        });

        expect(lines[0].payout).toBeNull();
        expect(lines[1].payout).toBe(600);
        expect(lines[1].commission).toBe(100);
    });

    it('uses a financial row at most once when matching by id', () => {
        const lines = enrichLines({
            ...posting(),
            products: [
                { offer_id: 'A', sku: 10, quantity: 1, price: { amount: '500', currency: 'RUB' } },
                { offer_id: 'B', sku: 10, quantity: 1, price: { amount: '500', currency: 'RUB' } }
            ],
            financial_products: [{ product_id: 10, payout: 400 }]
        });

        expect(lines[0].payout).toBe(400);
        expect(lines[1].payout).toBeNull();
    });

    it('counts a zero or missing quantity as one unit', () => {
        const lines = enrichLines({
            ...posting(),
            products: [
                { offer_id: 'A', sku: 1, quantity: 0, price: { amount: '300', currency: 'RUB' } }
            ],
            financial_products: []
        });

        expect(lines[0].quantity).toBe(1);
        expect(lines[0].gross).toBe(300);
    });
});

describe('commissionSpread', () => {
    /** One settled line of the given article: price 1000, quantity 1. */
    const line = (offerId: string, payout: number, commission: number) =>
        posting(
            { payout, commission_amount: commission },
            {
                products: [
                    {
                        offer_id: offerId,
                        name: offerId,
                        sku: 1,
                        quantity: 1,
                        price: { amount: '1000', currency: 'RUB' }
                    }
                ]
            }
        );

    it('measures the rate per article, not one rate for the account', () => {
        const spread = commissionSpread([line('a', 500, 500), line('b', 900, 100)]);

        expect(spread.articles).toBe(2);
        expect(spread.byKey.get('a')).toBeCloseTo(0.5);
        expect(spread.byKey.get('b')).toBeCloseTo(0.1);
        expect(spread.min).toBeCloseTo(0.1);
        expect(spread.max).toBeCloseTo(0.5);
    });

    it('leaves unsettled lines out, so their zero commission cannot dilute a rate', () => {
        const spread = commissionSpread([line('a', 500, 500), line('a', 0, 0)]);

        expect(spread.byKey.get('a')).toBeCloseTo(0.5);
        expect(spread.max).toBeCloseTo(0.5);
        expect(spread.articles).toBe(1);
    });

    it('ignores cancelled orders', () => {
        const spread = commissionSpread([
            line('a', 500, 500),
            { ...line('b', 100, 1900), status: 'cancelled' }
        ]);

        expect(spread.articles).toBe(1);
        expect(spread.byKey.has('b')).toBe(false);
    });

    it('is empty-safe', () => {
        const spread = commissionSpread([]);

        expect(spread.min).toBeNull();
        expect(spread.median).toBeNull();
        expect(spread.max).toBeNull();
        expect(spread.articles).toBe(0);
    });
});

describe('moneySummary', () => {
    it('separates buyer money from seller money', () => {
        const summary = moneySummary([
            posting({ payout: 1400, commission_amount: 600, total_discount_value: 500 })
        ]);

        expect(summary.gross).toBe(2000);
        expect(summary.payout).toBe(1400);
        expect(summary.commission).toBe(600);
        expect(summary.payoutRatio).toBeCloseTo(0.7);
        expect(summary.commissionRate).toBeCloseTo(0.3);
        expect(summary.complete).toBe(true);
    });

    it('reports ratios over the lines that actually have money', () => {
        const summary = moneySummary([
            posting({ payout: 1400, commission_amount: 600 }),
            posting() // no financial data at all
        ]);

        expect(summary.gross).toBe(4000);
        expect(summary.totalLines).toBe(2);
        expect(summary.reportedLines).toBe(1);
        // The ratio describes the reported half, and `complete` says so.
        expect(summary.payoutRatio).toBeCloseTo(0.7);
        expect(summary.complete).toBe(false);
    });

    it('returns null ratios when nothing was reported', () => {
        const summary = moneySummary([posting()]);

        expect(summary.payoutRatio).toBeNull();
        expect(summary.commissionRate).toBeNull();
        expect(summary.complete).toBe(false);
    });

    it('treats zero commission and zero payout as not yet calculated', () => {
        // The live shape of an order Ozon has not settled: a real price, and zeroes where the
        // money will appear. Counting it as reported dragged the commission rate down and left
        // the three figures unable to add up.
        const summary = moneySummary([
            posting({ payout: 0, commission_amount: 0 }),
            posting({ payout: 1400, commission_amount: 600 })
        ]);

        expect(summary.settledGross).toBe(2000);
        expect(summary.pendingGross).toBe(2000);
        expect(summary.reportedLines).toBe(1);
        expect(summary.commissionRate).toBeCloseTo(0.3);
        expect(summary.complete).toBe(false);
    });

    it('makes commission and payout add up to the settled lines', () => {
        // The identity that holds for every settled line, and the reason the block can be read
        // as a chain: commission + payout = the price of what Ozon has calculated.
        const summary = moneySummary([
            posting({ payout: 1400, commission_amount: 600 }),
            posting({ payout: 0, commission_amount: 0 }),
            posting({ payout: 900, commission_amount: 1100 })
        ]);

        expect(summary.commission + summary.payout).toBeCloseTo(summary.settledGross, 2);
        expect(summary.settledGross).toBe(4000);
    });

    it('is complete only when nothing is left uncalculated', () => {
        expect(moneySummary([posting({ payout: 100, commission_amount: 50 })]).complete).toBe(true);
        expect(moneySummary([posting({ payout: 0, commission_amount: 0 })]).complete).toBe(false);
    });

    it('is empty-safe', () => {
        const summary = moneySummary([]);

        expect(summary.gross).toBe(0);
        expect(summary.payoutRatio).toBeNull();
        expect(summary.complete).toBe(false);
    });
});

describe('skuEconomics', () => {
    const noCosts = () => undefined;

    it('aggregates units and money per seller article', () => {
        const rows = skuEconomics(
            [posting({ payout: 700, commission_amount: 300 }, { posting_number: 'a' }),
             posting({ payout: 1400, commission_amount: 600 }, { posting_number: 'b' })],
            noCosts
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].key).toBe('ART-1');
        expect(rows[0].units).toBe(4);
        expect(rows[0].gross).toBe(4000);
        expect(rows[0].payout).toBe(2100);
    });

    it('leaves profit unknown without a cost', () => {
        const rows = skuEconomics([posting({ payout: 700 })], noCosts);

        expect(rows[0].cogs).toBeNull();
        expect(rows[0].grossProfit).toBeNull();
        expect(rows[0].marginPercent).toBeNull();
        expect(rows[0].costCoverage).toBe(0);
        expect(rows[0].payoutCoverage).toBe(1);
    });

    it('computes margin against payout, not against revenue', () => {
        // 2 units, cost 100 each = 200; payout 700.
        const rows = skuEconomics([posting({ payout: 700 })], () => 100);

        expect(rows[0].cogs).toBe(200);
        expect(rows[0].grossProfit).toBe(500);
        expect(rows[0].marginPercent).toBeCloseTo((500 / 700) * 100);
        expect(rows[0].costCoverage).toBe(1);
    });

    it('refuses a profit figure while the cost covers only part of the units', () => {
        // Two postings of one unit each; only the first has a cost.
        const rows = skuEconomics(
            [
                posting({ payout: 700 }, { posting_number: 'a', created_at: '2026-09-10T00:00:00Z' }),
                posting({ payout: 700 }, { posting_number: 'b', created_at: '2026-09-11T00:00:00Z' })
            ],
            (_offerId, _sku, at) => (at.getUTCDate() === 10 ? 100 : undefined)
        );

        expect(rows[0].units).toBe(4);
        expect(rows[0].costCoverage).toBeCloseTo(0.5);
        // A partial cost would have shown a fake 2400 profit, so it stays unknown.
        expect(rows[0].grossProfit).toBeNull();
        expect(rows[0].cogs).toBe(200);
    });

    it('refuses a profit figure while Ozon reported only part of the payout', () => {
        const rows = skuEconomics(
            [
                posting({ payout: 700 }, { posting_number: 'a' }),
                posting(undefined, { posting_number: 'b' })
            ],
            () => 100
        );

        expect(rows[0].payoutCoverage).toBeCloseTo(0.5);
        expect(rows[0].grossProfit).toBeNull();
    });

    it('resolves the cost as of the order date, not as of today', () => {
        // Cost was 100 in August and 300 in September.
        const costs = (_offerId: string, _sku: number, at: Date) =>
            at.getUTCMonth() === 8 ? 300 : 100;

        const rows = skuEconomics(
            [
                posting({ payout: 700 }, { posting_number: 'aug', created_at: '2026-08-20T00:00:00Z' }),
                posting({ payout: 700 }, { posting_number: 'sep', created_at: '2026-09-20T00:00:00Z' })
            ],
            costs
        );

        // 2 units at 100 plus 2 units at 300.
        expect(rows[0].cogs).toBe(800);
        expect(rows[0].grossProfit).toBe(600);
    });

    it('falls back to the SKU when the article is empty', () => {
        const rows = skuEconomics(
            [
                {
                    ...posting({ payout: 100 }),
                    products: [{ offer_id: '', sku: 77, quantity: 1, price: { amount: '100', currency: 'RUB' } }]
                }
            ],
            noCosts
        );

        expect(rows[0].key).toBe('77');
    });
});

describe('abcAnalysis', () => {
    it('splits by cumulative share into A, B and C', () => {
        const rows = abcAnalysis([
            { key: 'a', label: 'A', value: 80 },
            { key: 'b', label: 'B', value: 15 },
            { key: 'c', label: 'C', value: 5 }
        ]);

        expect(rows.map((row) => row.grade)).toEqual(['A', 'B', 'C']);
        expect(rows[0].cumulativeShare).toBeCloseTo(80);
        expect(rows[1].cumulativeShare).toBeCloseTo(95);
        expect(rows[2].cumulativeShare).toBeCloseTo(100);
    });

    it('ranks by the value it is given, not by position', () => {
        const rows = abcAnalysis([
            { key: 'small', label: 'small', value: 1 },
            { key: 'big', label: 'big', value: 99 }
        ]);

        expect(rows[0].key).toBe('big');
        // One product carrying 99% of the value enters class A, not C.
        expect(rows[0].grade).toBe('A');
        expect(rows[1].grade).toBe('C');
    });

    it('ignores non-positive values and empty input', () => {
        expect(abcAnalysis([])).toEqual([]);
        expect(abcAnalysis([{ key: 'a', label: 'a', value: 0 }])).toEqual([]);
    });
});

describe('breakEvenPrice', () => {
    it('divides cost by the payout ratio', () => {
        // Keeps 70% of the price; a 700 cost needs a 1000 price.
        expect(breakEvenPrice(700, 0.7)).toBeCloseTo(1000);
    });

    it('is unknown without a cost or without a ratio', () => {
        expect(breakEvenPrice(null, 0.7)).toBeNull();
        expect(breakEvenPrice(700, null)).toBeNull();
        expect(breakEvenPrice(700, 0)).toBeNull();
    });
});

describe('lossMaking', () => {
    it('selects only rows with a known negative profit', () => {
        const rows = skuEconomics([posting({ payout: 700 })], () => 500);
        // 2 units at 500 = 1000 against a payout of 700.
        expect(lossMaking(rows)).toHaveLength(1);

        const unknown = skuEconomics([posting({ payout: 700 })], () => undefined);
        expect(lossMaking(unknown)).toHaveLength(0);
    });
});

describe('costBookLookup', () => {
    it('resolves a past date from a cost entered today', () => {
        // The seller enters a cost now and expects to see the margin for a finished month.
        // `costAt` carries the earliest known point backwards, so the lookup must answer
        // rather than report the cost as missing.
        const book = setCost({}, 'suitcasecoverredrabbit', 420, '2026-10-03');
        const lookup = costBookLookup(book);

        expect(lookup('suitcasecoverredrabbit', 2103351437, new Date(2026, 8, 30))).toBe(420);
        expect(lookup('suitcasecoverredrabbit', 2103351437, new Date(2026, 0, 15))).toBe(420);
    });

    it('prefers the point that applied at the time when there is one', () => {
        const book = setCost(
            setCost({}, 'case', 300, '2026-01-01'),
            'case',
            400,
            '2026-06-01'
        );
        const lookup = costBookLookup(book);

        expect(lookup('case', 1, new Date(2026, 2, 15))).toBe(300);
        expect(lookup('case', 1, new Date(2026, 8, 15))).toBe(400);
    });

    it('answers nothing for a product with no cost at all', () => {
        const lookup = costBookLookup(setCost({}, 'known', 100, '2026-01-01'));

        expect(lookup('unknown', 999, new Date(2026, 8, 15))).toBeUndefined();
    });

    it('keys by article, falling back to the sku when the article is empty', () => {
        // Callers normalise a missing article to an empty string, so that is the case to
        // pin: the cost must still be found by sku.
        const book = { '2103351437': [{ from: '2026-01-01', unitCost: 250 }] };
        const lookup = costBookLookup(book);

        expect(lookup('', 2103351437, new Date(2026, 8, 15))).toBe(250);
    });
});

describe('costKey', () => {
    it('prefers the trimmed article and falls back to the SKU', () => {
        expect(costKey(' ART ', 5)).toBe('ART');
        expect(costKey('', 5)).toBe('5');
        expect(costKey(undefined, 5)).toBe('5');
    });
});
