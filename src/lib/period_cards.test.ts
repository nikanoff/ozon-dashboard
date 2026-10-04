import { describe, expect, it } from 'vitest';
import {
    accrualTotals,
    cardAccrualDays,
    cardProfit,
    cardReturnsWindow,
    cardWindows,
    costOfGoods,
    dayRangeLabel,
    daysBetween,
    deltaPercent,
    ordersTotals,
    realizationCost,
    returnsTotals
} from './period_cards';
import type { AccrualDaySummary } from './accruals';
import type { RealizationSku } from './realization';
import type { DashboardPosting, OzonReturn } from './ozon_types';

/** Sunday, 4 October 2026, local noon. */
const NOW = new Date(2026, 9, 4, 12, 0, 0);

function posting(overrides: Partial<DashboardPosting> = {}): DashboardPosting {
    return {
        posting_number: '1-1',
        status: 'delivered',
        created_at: NOW.toISOString(),
        products: [
            { offer_id: 'offer', sku: 1, quantity: 1, price: { amount: '1000', currency: 'RUB' } }
        ],
        financial_products: [],
        actions: [],
        ...overrides
    };
}

function accrualDay(date: string, overrides: Partial<AccrualDaySummary> = {}): AccrualDaySummary {
    return {
        date,
        status: 'ok',
        net: 0,
        gross: 0,
        byType: {},
        byCategory: {},
        cabinetByType: {},
        counts: { total: 0, withPosting: 0, cabinet: 0 },
        ...overrides
    };
}

function returnRow(overrides: Partial<OzonReturn> = {}): OzonReturn {
    return {
        id: 1,
        date: '2026-10-03',
        sku: 1,
        offerId: 'offer',
        units: 1,
        amount: 1000,
        type: 'Cancellation',
        ...overrides
    };
}

describe('cardWindows', () => {
    it('builds the four windows and their comparisons', () => {
        const windows = cardWindows(NOW);
        expect(windows.map((window) => window.key)).toEqual([
            'today',
            'yesterday',
            'monthToDate',
            'lastMonth'
        ]);

        const [today, yesterday, monthToDate, lastMonth] = windows;
        expect([today.from, today.to]).toEqual(['2026-10-04', '2026-10-04']);
        expect([today.compare?.from, today.compare?.to]).toEqual(['2026-10-03', '2026-10-03']);
        expect(today.open).toBe(true);
        expect(today.month).toBeNull();

        expect([yesterday.from, yesterday.to]).toEqual(['2026-10-03', '2026-10-03']);
        expect([yesterday.compare?.from, yesterday.compare?.to]).toEqual([
            '2026-10-02',
            '2026-10-02'
        ]);
        expect(yesterday.open).toBe(false);

        expect([monthToDate.from, monthToDate.to]).toEqual(['2026-10-01', '2026-10-04']);
        // The same days of the previous month, not the whole of it.
        expect([monthToDate.compare?.from, monthToDate.compare?.to]).toEqual([
            '2026-09-01',
            '2026-09-04'
        ]);
        expect(monthToDate.open).toBe(true);
        expect(monthToDate.month).toBe('2026-10');

        expect([lastMonth.from, lastMonth.to]).toEqual(['2026-09-01', '2026-09-30']);
        expect([lastMonth.compare?.from, lastMonth.compare?.to]).toEqual([
            '2026-08-01',
            '2026-08-31'
        ]);
        expect(lastMonth.open).toBe(false);
        expect(lastMonth.month).toBe('2026-09');
    });

    it('names the comparison window short enough to sit beside a percentage', () => {
        const windows = cardWindows(NOW);

        // What the badge reads: «+62,9 % к 2 окт.» — the base is stated, not guessed at.
        expect(windows.find((window) => window.key === 'yesterday')?.compare?.short).toBe('2 окт.');
        expect(windows.find((window) => window.key === 'monthToDate')?.compare?.short).toBe(
            '1–4 сент.'
        );
        expect(windows.find((window) => window.key === 'lastMonth')?.compare?.short).toBe('авг. 2026');
    });

    it('keeps yesterday inside the previous month on the first day of a month', () => {
        const windows = cardWindows(new Date(2026, 9, 1, 9, 0, 0));
        const [today, yesterday, monthToDate, lastMonth] = windows;

        expect(today.range).toBe('1 октября');
        expect([yesterday.from, yesterday.to]).toEqual(['2026-09-30', '2026-09-30']);
        // A month one day old compares against the first day of the previous one.
        expect([monthToDate.from, monthToDate.to]).toEqual(['2026-10-01', '2026-10-01']);
        expect([monthToDate.compare?.from, monthToDate.compare?.to]).toEqual([
            '2026-09-01',
            '2026-09-01'
        ]);
        expect([lastMonth.from, lastMonth.to]).toEqual(['2026-09-01', '2026-09-30']);
    });

    it('clips the comparison when the previous month is shorter', () => {
        // 31 March against February: the month so far has more days than the one before it.
        const windows = cardWindows(new Date(2026, 2, 31, 12, 0, 0));
        const monthToDate = windows.find((window) => window.key === 'monthToDate');

        expect([monthToDate?.compare?.from, monthToDate?.compare?.to]).toEqual([
            '2026-02-01',
            '2026-02-28'
        ]);
    });
});

describe('dayRangeLabel', () => {
    it('names a single day, a span inside a month, and a span across months', () => {
        expect(dayRangeLabel('2026-10-04', '2026-10-04')).toBe('4 октября');
        expect(dayRangeLabel('2026-10-01', '2026-10-04')).toBe('1–4 октября');
        expect(dayRangeLabel('2026-09-28', '2026-10-02')).toBe('28 сентября — 2 октября');
    });
});

describe('daysBetween', () => {
    it('lists both edges inclusively', () => {
        expect(daysBetween('2026-10-01', '2026-10-04')).toEqual([
            '2026-10-01',
            '2026-10-02',
            '2026-10-03',
            '2026-10-04'
        ]);
    });

    it('returns nothing for a reversed window instead of looping', () => {
        expect(daysBetween('2026-10-04', '2026-10-01')).toEqual([]);
    });
});

describe('cardAccrualDays', () => {
    it('covers the previous month and the current one up to today', () => {
        const days = cardAccrualDays(NOW);

        expect(days[0]).toBe('2026-09-01');
        expect(days).toContain('2026-09-30');
        expect(days).toContain('2026-10-01');
        expect(days[days.length - 1]).toBe('2026-10-04');
        // Two months at most: the widest window the accrual endpoint accepts in one call.
        expect(days.length).toBe(34);
    });

    it('states the returns window as the previous month through today', () => {
        expect(cardReturnsWindow(NOW)).toEqual({ from: '2026-09-01', to: '2026-10-04' });
    });
});

describe('ordersTotals', () => {
    it('sums seller money and units, and keeps cancellations apart', () => {
        const postings = [
            posting({ posting_number: 'a', created_at: new Date(2026, 9, 3, 10).toISOString() }),
            posting({
                posting_number: 'b',
                status: 'cancelled',
                created_at: new Date(2026, 9, 3, 11).toISOString(),
                products: [
                    { offer_id: 'offer', sku: 1, quantity: 2, price: { amount: '500', currency: 'RUB' } }
                ]
            }),
            // Outside the window.
            posting({ posting_number: 'c', created_at: new Date(2026, 9, 1, 10).toISOString() })
        ];

        const totals = ordersTotals(postings, '2026-10-03', '2026-10-03');

        expect(totals.sales).toBe(1000);
        expect(totals.orders).toBe(1);
        expect(totals.units).toBe(1);
        expect(totals.cancelled).toBe(1);
        expect(totals.cancelledSum).toBe(1000);
        expect(totals.cancelledUnits).toBe(2);
    });

    it('counts the orders that travelled between clusters', () => {
        const postings = [
            posting({
                posting_number: 'a',
                created_at: new Date(2026, 9, 3, 10).toISOString(),
                financial_data: { cluster_from: 'Москва', cluster_to: 'Казань' }
            }),
            posting({
                posting_number: 'b',
                created_at: new Date(2026, 9, 3, 12).toISOString(),
                financial_data: { cluster_from: 'Москва', cluster_to: 'Москва' }
            })
        ];

        expect(ordersTotals(postings, '2026-10-03', '2026-10-03').crossCluster).toBe(1);
    });

    it('ignores a posting with an unreadable date', () => {
        const totals = ordersTotals([posting({ created_at: 'not a date' })], '2026-10-01', '2026-10-04');
        expect(totals.sales).toBe(0);
        expect(totals.orders).toBe(0);
    });
});

describe('accrualTotals', () => {
    it('sums the day nets and reads advertising as a positive cost', () => {
        const days = {
            '2026-10-01': accrualDay('2026-10-01', {
                net: 1000,
                byType: { '41': -250.5, '32': -100 },
                cabinetByType: { total: -250.5, '41': -250.5 }
            }),
            '2026-10-02': accrualDay('2026-10-02', { net: 500, byType: { '54': -49.5 } })
        };

        const totals = accrualTotals(days, ['2026-10-01', '2026-10-02']);

        expect(totals.net).toBe(1500);
        expect(totals.advertising).toBe(300);
        // Advertising by type is what a tooltip names; only the types that were charged appear.
        expect(totals.advertisingByType).toEqual({ '41': 250.5, '54': 49.5 });
        expect(totals.complete).toBe(true);
    });

    it('splits the net into orders and the cabinet own costs', () => {
        const days = {
            '2026-10-01': accrualDay('2026-10-01', {
                net: 1000,
                byType: { '32': -100 },
                byCategory: { POSTING: 700, ITEM: -100, NON_ITEM: -300 },
                cabinetByType: { total: -300, '41': -300 }
            })
        };

        const totals = accrualTotals(days, ['2026-10-01']);

        // The cabinet's share is already inside `net`, so the orders are what remains.
        expect(totals.cabinet).toBe(-300);
        expect(totals.orders).toBe(1300);
        expect(totals.net).toBe(1000);
        // The category split is what the payout tooltip names: shipment, product, cabinet.
        expect(totals.byCategory).toEqual({ POSTING: 700, ITEM: -100, NON_ITEM: -300 });
    });

    it('names a day that was never fetched, and refuses to call the window complete', () => {
        const totals = accrualTotals({ '2026-10-01': accrualDay('2026-10-01') }, [
            '2026-10-01',
            '2026-10-02'
        ]);

        expect(totals.missing).toEqual(['2026-10-02']);
        expect(totals.failed).toEqual([]);
        expect(totals.complete).toBe(false);
    });

    it('keeps a failed day out of the sum and reports it as failed', () => {
        const totals = accrualTotals(
            {
                '2026-10-01': accrualDay('2026-10-01', { net: 100 }),
                '2026-10-02': accrualDay('2026-10-02', { status: 'failed', net: 0 })
            },
            ['2026-10-01', '2026-10-02']
        );

        // A failed call must not be mistaken for a quiet day, so the sum stays partial and
        // says so through `complete` instead of pretending the day was empty.
        expect(totals.net).toBe(100);
        expect(totals.failed).toEqual(['2026-10-02']);
        expect(totals.complete).toBe(false);
    });

    it('counts an empty day as data, not as a gap', () => {
        const totals = accrualTotals(
            { '2026-10-04': accrualDay('2026-10-04', { status: 'empty' }) },
            ['2026-10-04']
        );

        expect(totals.complete).toBe(true);
        expect(totals.net).toBe(0);
        expect(totals.loaded).toBe(1);
    });
});

describe('returnsTotals', () => {
    it('counts returns inside the window and splits them by Ozon type', () => {
        const totals = returnsTotals(
            [
                returnRow({ id: 1, date: '2026-10-03', units: 2, amount: 2000 }),
                returnRow({ id: 2, date: '2026-10-01', type: 'ClientReturn', amount: 700 }),
                returnRow({ id: 3, date: '2026-10-01', type: 'FullReturn', amount: 300 }),
                returnRow({ id: 4, date: '2026-09-30', amount: 5000 })
            ],
            '2026-10-01',
            '2026-10-04'
        );

        expect(totals.count).toBe(3);
        expect(totals.units).toBe(4);
        expect(totals.amount).toBe(3000);
        // Each kind carries its own money and units, so a tooltip can name the difference
        // between an order nobody collected and one that came back after delivery.
        expect(totals.notPickedUp).toEqual({ count: 1, units: 2, amount: 2000 });
        expect(totals.clientReturn).toEqual({ count: 1, units: 1, amount: 700 });
        expect(totals.other).toEqual({ count: 1, units: 1, amount: 300 });
    });
});

describe('costOfGoods', () => {
    const costs = (offerId: string, sku: number, at: Date) => {
        if (offerId !== 'offer') return undefined;
        // A price change: July's cost is 300, August's is 400.
        return at.getMonth() >= 6 ? 400 : 300;
    };

    it('values sold units at the cost of the day they were ordered', () => {
        const postings = [
            posting({
                posting_number: 'a',
                created_at: new Date(2026, 8, 10, 10).toISOString(),
                products: [{ offer_id: 'offer', sku: 1, quantity: 2 }]
            })
        ];

        const result = costOfGoods(postings, [], '2026-09-01', '2026-09-30', costs);

        expect(result.cogs).toBe(800);
        expect(result.units).toBe(2);
        expect(result.complete).toBe(true);
    });

    it('takes returned units back out of the cost, per article', () => {
        const postings = [
            posting({
                posting_number: 'a',
                created_at: new Date(2026, 8, 10, 10).toISOString(),
                products: [{ offer_id: 'offer', sku: 1, quantity: 3 }]
            })
        ];

        const result = costOfGoods(
            postings,
            [returnRow({ date: '2026-09-20', units: 1 })],
            '2026-09-01',
            '2026-09-30',
            costs
        );

        expect(result.units).toBe(2);
        expect(result.cogs).toBe(800);
    });

    it('ignores returns beyond what sold in the window', () => {
        const postings = [
            posting({
                posting_number: 'a',
                created_at: new Date(2026, 8, 10, 10).toISOString(),
                products: [{ offer_id: 'offer', sku: 1, quantity: 1 }]
            })
        ];

        const result = costOfGoods(
            postings,
            [returnRow({ date: '2026-09-20', units: 4 })],
            '2026-09-01',
            '2026-09-30',
            costs
        );

        // The extra returns belong to sales of earlier windows, so no cost is invented here.
        expect(result.units).toBe(0);
        expect(result.cogs).toBe(0);
        expect(result.complete).toBe(true);
    });

    it('is incomplete when an article has no cost', () => {
        const postings = [
            posting({
                posting_number: 'a',
                created_at: new Date(2026, 8, 10, 10).toISOString(),
                products: [
                    { offer_id: 'offer', sku: 1, quantity: 1 },
                    { offer_id: 'unknown', sku: 2, quantity: 1 }
                ]
            })
        ];

        const result = costOfGoods(postings, [], '2026-09-01', '2026-09-30', costs);

        expect(result.cogs).toBe(400);
        expect(result.units).toBe(2);
        expect(result.coveredUnits).toBe(1);
        expect(result.complete).toBe(false);
    });
});

describe('cardProfit', () => {
    const completeAccrual = accrualTotals(
        { '2026-09-01': accrualDay('2026-09-01', { net: 8000 }) },
        ['2026-09-01']
    );
    const completeCost = { cogs: 3000, units: 2, coveredUnits: 2, complete: true };

    it('chains payout, cost and tax without subtracting advertising twice', () => {
        const result = cardProfit({
            // Advertising is inside `net`; the figure is only reported beside it.
            accrual: { ...completeAccrual, advertising: 900 },
            realized: 20000,
            cost: completeCost,
            taxPercent: 7,
            base: 'realized'
        });

        expect(result.payout).toBe(8000);
        expect(result.taxable).toBe(20000);
        expect(result.grossProfit).toBe(5000);
        // 7 % of the realized revenue, not of the payout.
        expect(result.tax).toBe(1400);
        expect(result.netProfit).toBe(3600);
    });

    it('charges the tax on the payout when that is the base, with no monthly report', () => {
        // A money-based regime needs nothing but the accruals, so a day of the running month
        // still has a tax — and therefore a net.
        const result = cardProfit({
            accrual: completeAccrual,
            realized: null,
            cost: completeCost,
            taxPercent: 7,
            base: 'payout'
        });

        expect(result.taxable).toBe(8000);
        expect(result.tax).toBe(560);
        expect(result.netProfit).toBe(4440);
    });

    it('has no revenue base without the monthly report, and says so instead of guessing', () => {
        // The order feed's seller price is not the realized revenue: in September 2026 it was
        // 1,96 times larger, so a revenue-based tax built on it was nearly twice the real one.
        const result = cardProfit({
            accrual: completeAccrual,
            realized: null,
            cost: completeCost,
            taxPercent: 7,
            base: 'realized'
        });

        expect(result.taxable).toBeNull();
        expect(result.tax).toBeNull();
        // Gross profit needs no report, so it stays.
        expect(result.grossProfit).toBe(5000);
        expect(result.netProfit).toBeNull();
    });

    it('withholds the money when the accruals do not cover the window', () => {
        const incomplete = accrualTotals({}, ['2026-10-04']);
        const result = cardProfit({
            accrual: incomplete,
            realized: 1000,
            cost: { cogs: 100, units: 1, coveredUnits: 1, complete: true },
            taxPercent: 7,
            base: 'realized'
        });

        expect(result.payout).toBeNull();
        expect(result.grossProfit).toBeNull();
        expect(result.netProfit).toBeNull();
        // The tax is still stated: it is owed on the realized revenue whatever the payout
        // feed says, and hiding it would understate what the seller owes.
        expect(result.tax).toBe(70);
    });

    it('withholds profit when the cost book cannot cover the units', () => {
        const partial = { cogs: 1000, units: 3, coveredUnits: 1, complete: false };
        const byRealized = cardProfit({
            accrual: completeAccrual,
            realized: 20000,
            cost: partial,
            taxPercent: 7,
            base: 'realized'
        });

        expect(byRealized.payout).toBe(8000);
        expect(byRealized.cogs).toBeNull();
        expect(byRealized.grossProfit).toBeNull();
        expect(byRealized.netProfit).toBeNull();
        // The revenue base does not depend on the cost book, so the tax stays.
        expect(byRealized.tax).toBe(1400);
        expect(byRealized.costKnown).toBe(false);
        expect(byRealized.costCoverage).toBeCloseTo(1 / 3);

        // A margin regime is charged on revenue minus cost, so an unknown cost leaves no base.
        const byMargin = cardProfit({
            accrual: completeAccrual,
            realized: 20000,
            cost: partial,
            taxPercent: 7,
            base: 'margin'
        });

        expect(byMargin.taxable).toBeNull();
        expect(byMargin.tax).toBeNull();
        expect(byMargin.netProfit).toBeNull();
    });
});

describe('realizationCost', () => {
    const costs = (offerId: string) => (offerId === 'known' ? 250 : undefined);
    const line = (offerId: string, units: number, returnedUnits = 0): RealizationSku => ({
        offerId,
        sku: 1,
        name: offerId,
        units,
        returnedUnits,
        realized: 0,
        returned: 0,
        loyalty: 0
    });

    it('values sold units net of the report own returns', () => {
        const result = realizationCost([line('known', 4, 1)], new Date(2026, 8, 30), costs);

        expect(result.units).toBe(3);
        expect(result.cogs).toBe(750);
        expect(result.complete).toBe(true);
    });

    it('is incomplete when an article has no cost, and complete for an empty month', () => {
        const partial = realizationCost(
            [line('known', 1), line('unknown', 1)],
            new Date(2026, 8, 30),
            costs
        );
        expect(partial.cogs).toBe(250);
        expect(partial.units).toBe(2);
        expect(partial.coveredUnits).toBe(1);
        expect(partial.complete).toBe(false);

        const empty = realizationCost([], new Date(2026, 8, 30), costs);
        expect(empty.cogs).toBe(0);
        expect(empty.complete).toBe(true);
    });
});

describe('deltaPercent', () => {
    it('measures growth against a non-zero base only', () => {
        expect(deltaPercent(110, 100)).toBeCloseTo(10);
        expect(deltaPercent(90, 100)).toBeCloseTo(-10);
        expect(deltaPercent(10, 0)).toBeNull();
        expect(deltaPercent(0, 0)).toBeNull();
    });
});
