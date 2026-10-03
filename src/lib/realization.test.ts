import { describe, expect, it } from 'vitest';
import {
    mergeCostCandidates,
    monthBounds,
    monthParts,
    monthView,
    payoutPeriods,
    profitAfterTaxAndCost,
    recentMonths,
    serviceLabel,
    taxableAmount,
    toBalanceSummary,
    toCashflowBreakdown,
    toRealizationMonth,
    toWeekFlows
} from './realization';

/** A live-shaped realization row, trimmed to the fields that matter. */
const row = (over: Record<string, unknown> = {}) => ({
    row_number: 1,
    item: { sku: 2095433653, name: 'Брелок на сумку', offer_id: 'bagpendantbrown' },
    seller_price_per_instance: 912,
    delivery_commission: {
        price_per_instance: 459.49,
        quantity: 1,
        amount: 459.49,
        commission: 0,
        bonus: 447.92,
        standard_fee: 446.88,
        total: 465.12,
        bank_coinvestment: 4.59,
        pick_up_point_coinvestment: 0
    },
    return_commission: null,
    commission_ratio: 0.49,
    ...over
});

describe('toRealizationMonth', () => {
    it('reads the totals the report file also shows', () => {
        // Two realized lines and one return, matching the verified field mapping.
        const month = toRealizationMonth({
            result: {
                rows: [
                    row(),
                    row({ item: { sku: 42, name: 'Чехол', offer_id: 'case' }, delivery_commission: { quantity: 2, amount: 1000, bank_coinvestment: 10 } }),
                    row({
                        item: { sku: 42, name: 'Чехол', offer_id: 'case' },
                        delivery_commission: { quantity: 0, amount: 0, bank_coinvestment: 0 },
                        return_commission: { quantity: 1, amount: 300, bank_coinvestment: 3 }
                    })
                ]
            }
        });

        expect(month.rows).toBe(3);
        expect(month.units).toBe(3);
        expect(month.returnedUnits).toBe(1);
        expect(month.realized).toBeCloseTo(1459.49, 2);
        expect(month.returned).toBeCloseTo(300, 2);
        expect(month.net).toBeCloseTo(1159.49, 2);
        expect(month.loyalty).toBeCloseTo(14.59, 2);
        expect(month.loyaltyReturned).toBeCloseTo(3, 2);
        expect(month.loyaltyNet).toBeCloseTo(11.59, 2);
    });

    it('rolls rows up by sku, biggest first', () => {
        const month = toRealizationMonth({
            rows: [
                row({ item: { sku: 1, name: 'A', offer_id: 'a' }, delivery_commission: { quantity: 1, amount: 100 } }),
                row({ item: { sku: 2, name: 'B', offer_id: 'b' }, delivery_commission: { quantity: 1, amount: 900 } }),
                row({ item: { sku: 1, name: 'A', offer_id: 'a' }, delivery_commission: { quantity: 3, amount: 300 } })
            ]
        });

        expect(month.perSku).toHaveLength(2);
        expect(month.perSku[0].sku).toBe(2);
        const first = month.perSku.find((entry) => entry.sku === 1);
        expect(first?.units).toBe(4);
        expect(first?.realized).toBeCloseTo(400, 2);
    });

    it('treats a missing quantity as one unit rather than zero', () => {
        const month = toRealizationMonth({
            rows: [row({ delivery_commission: { amount: 500 } })]
        });

        expect(month.units).toBe(1);
        expect(month.returnedUnits).toBe(0);
        expect(month.returned).toBe(0);
    });

    it('is empty-safe', () => {
        for (const input of [null, undefined, {}, { rows: [] }, { result: { rows: [] } }]) {
            const month = toRealizationMonth(input);
            expect(month.rows).toBe(0);
            expect(month.realized).toBe(0);
            expect(month.net).toBe(0);
            expect(month.perSku).toEqual([]);
        }
    });

    it('skips rows without a usable sku instead of inventing one', () => {
        const month = toRealizationMonth({ rows: [row({ item: { name: 'без sku' } })] });

        expect(month.rows).toBe(1);
        expect(month.realized).toBeCloseTo(459.49, 2);
        expect(month.perSku).toEqual([]);
    });
});

describe('toBalanceSummary', () => {
    it('reads the live shape, where money is wrapped and payments is a list', () => {
        const balance = toBalanceSummary({
            result: {
                total: {
                    opening_balance: { value: 200000, currency_code: 'RUB' },
                    closing_balance: { value: 250000, currency_code: 'RUB' },
                    accrued: { value: 130000, currency_code: 'RUB' },
                    payments: [{ value: -80000, currency_code: 'RUB' }]
                },
                cashflows: {}
            }
        });

        expect(balance).toEqual({
            opening: 200000,
            closing: 250000,
            accrued: 130000,
            paid: -80000
        });
    });

    it('sums several payments', () => {
        const balance = toBalanceSummary({
            total: { payments: [{ value: -100 }, { value: -200.5 }] }
        });

        expect(balance?.paid).toBeCloseTo(-300.5, 2);
    });

    it('returns null when there is no total, rather than zeros', () => {
        expect(toBalanceSummary({})).toBeNull();
        expect(toBalanceSummary(null)).toBeNull();
    });

    it('keeps a payment that arrives as a plain number', () => {
        expect(toBalanceSummary({ total: { payments: -500 } })?.paid).toBe(-500);
    });
});

describe('toWeekFlows', () => {
    it('reads the live shape and sums each week', () => {
        const weeks = toWeekFlows({
            result: {
                cash_flows: [
                    {
                        period: { id: 0, begin: '2026-09-21T00:00:00Z', end: '2026-09-27T00:00:00Z' },
                        orders_amount: 101877,
                        returns_amount: -14591,
                        commission_amount: -44897.08,
                        services_amount: -12657.42,
                        item_delivery_and_return_amount: -11442.17,
                        currency_code: 'RUB'
                    }
                ],
                page_count: 1
            }
        });

        expect(weeks).toHaveLength(1);
        expect(weeks[0].from).toBe('2026-09-21');
        expect(weeks[0].to).toBe('2026-09-27');
        expect(weeks[0].net).toBeCloseTo(18289.33, 2);
    });

    it('orders weeks oldest first', () => {
        const weeks = toWeekFlows({
            cash_flows: [
                { period: { begin: '2026-09-28T00:00:00Z' }, orders_amount: 2 },
                { period: { begin: '2026-09-07T00:00:00Z' }, orders_amount: 1 }
            ]
        });

        expect(weeks.map((week) => week.from)).toEqual(['2026-09-07', '2026-09-28']);
    });

    it('is empty-safe', () => {
        expect(toWeekFlows(null)).toEqual([]);
        expect(toWeekFlows({})).toEqual([]);
    });
});

describe('payoutPeriods', () => {
    it('splits september the way the cabinet does', () => {
        // Taken from the seller's own payout report: 01–06, 07–13, 14–20, 21–27, 28–30.
        expect(payoutPeriods('2026-09')).toEqual([
            { from: '2026-09-01', to: '2026-09-06' },
            { from: '2026-09-07', to: '2026-09-13' },
            { from: '2026-09-14', to: '2026-09-20' },
            { from: '2026-09-21', to: '2026-09-27' },
            { from: '2026-09-28', to: '2026-09-30' }
        ]);
    });

    it('covers every day of the month exactly once', () => {
        const days = payoutPeriods('2026-09').flatMap((period) => {
            const collected: string[] = [];
            const cursor = new Date(`${period.from}T00:00:00`);
            const end = new Date(`${period.to}T00:00:00`);
            while (cursor <= end) {
                collected.push(
                    `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
                );
                cursor.setDate(cursor.getDate() + 1);
            }
            return collected;
        });

        expect(days).toHaveLength(30);
        expect(new Set(days).size).toBe(30);
    });

    it('starts on the first of the month whatever weekday that is', () => {
        const august = payoutPeriods('2026-08');

        expect(august[0].from).toBe('2026-08-01');
        expect(august.at(-1)?.to).toBe('2026-08-31');
    });

    it('handles a month that starts on a monday', () => {
        // June 2026 starts on a Monday, so the first period is a whole week.
        const june = payoutPeriods('2026-06');

        expect(june[0]).toEqual({ from: '2026-06-01', to: '2026-06-07' });
    });

    it('is empty for an unusable month', () => {
        expect(payoutPeriods('nonsense')).toEqual([]);
    });
});

describe('toCashflowBreakdown', () => {
    /**
     * A synthetic balance response, shaped like the live one and internally consistent:
     * sales are the sum of their parts, the accrual equals sales minus fees plus services,
     * and the closing balance is the opening one plus the accrual minus the payments.
     */
    const live = {
        total: {
            opening_balance: { value: 200000, currency_code: 'RUB' },
            closing_balance: { value: 250000, currency_code: 'RUB' },
            accrued: { value: 130000, currency_code: 'RUB' },
            payments: [{ value: -80000, currency_code: 'RUB' }]
        },
        cashflows: {
            sales: {
                amount: { value: 500000, currency_code: 'RUB' },
                fee: { value: -250000, currency_code: 'RUB' },
                amount_details: {
                    revenue: { value: 300000, currency_code: 'RUB' },
                    points_for_discounts: '195000',
                    partner_programs: { value: 5000, currency_code: 'RUB' }
                }
            },
            returns: {
                amount: { value: -40000, currency_code: 'RUB' },
                fee: { value: 20000, currency_code: 'RUB' },
                amount_details: {
                    revenue: { value: -25000, currency_code: 'RUB' },
                    points_for_discounts: '-14500',
                    partner_programs: { value: -500, currency_code: 'RUB' }
                }
            },
            services: [
                { name: 'acquiring', amount: { value: -5000, currency_code: 'RUB' } },
                { name: 'packing_by_agents', amount: { value: -500, currency_code: 'RUB' } },
                {
                    name: 'product_placement_in_ozon_warehouses',
                    amount: { value: -3000, currency_code: 'RUB' }
                },
                { name: 'packing_package', amount: { value: -300, currency_code: 'RUB' } },
                {
                    name: 'delivery_to_handover_place_by_ozon',
                    amount: { value: -200, currency_code: 'RUB' }
                },
                { name: 'logistics', amount: { value: -70000, currency_code: 'RUB' } },
                { name: 'cross_docking', amount: { value: -1000, currency_code: 'RUB' } },
                {
                    name: 'partner_returns_cancellations_processing',
                    amount: { value: -1000, currency_code: 'RUB' }
                },
                { name: 'reverse_logistics', amount: { value: -8000, currency_code: 'RUB' } },
                {
                    name: 'courier_client_reinvoice',
                    amount: { value: -3000, currency_code: 'RUB' }
                },
                { name: 'pay_per_click', amount: { value: -8000, currency_code: 'RUB' } }
            ]
        }
    };

    it('separates the sales fee, which the realization report leaves at zero', () => {
        const breakdown = toCashflowBreakdown(live);

        expect(breakdown?.sales.fee).toBeCloseTo(-250000, 2);
        expect(breakdown?.sales.revenue).toBeCloseTo(300000, 2);
    });

    it('reads the string amounts and the parts of the sales amount', () => {
        const breakdown = toCashflowBreakdown(live);

        expect(breakdown?.sales.points).toBeCloseTo(195000, 2);
        expect(breakdown?.sales.partnerPrograms).toBeCloseTo(5000, 2);
        // The parts make up the group amount.
        const sales = breakdown?.sales;
        expect(sales && sales.revenue + sales.points + sales.partnerPrograms).toBeCloseTo(
            500000,
            2
        );
    });

    it('reads returns, whose parts are negative', () => {
        const breakdown = toCashflowBreakdown(live);

        expect(breakdown?.returns.revenue).toBeCloseTo(-25000, 2);
        expect(breakdown?.returns.points).toBeCloseTo(-14500, 2);
        expect(breakdown?.returns.fee).toBeCloseTo(20000, 2);
    });

    it('lists services by amount, largest charge first', () => {
        const breakdown = toCashflowBreakdown(live);

        expect(breakdown?.services[0].name).toBe('logistics');
        expect(breakdown?.services[1].name).toBe('reverse_logistics');
        expect(breakdown?.services).toHaveLength(11);
    });

    it('adds up to the accrued figure, which is the point of it', () => {
        // The fixture's own breakdown sums to the number its balance reports, which is what
        // the accrual layer produces from a different endpoint. This pins that the parts and
        // the whole agree.
        const breakdown = toCashflowBreakdown(live);

        expect(breakdown?.total).toBeCloseTo(130000, 2);
        expect(breakdown?.total).toBeCloseTo(live.total.accrued.value, 2);
    });

    it('is null when there is no breakdown rather than a page of zeros', () => {
        expect(toCashflowBreakdown({})).toBeNull();
        expect(toCashflowBreakdown(null)).toBeNull();
        expect(toCashflowBreakdown({ total: {} })).toBeNull();
    });

    it('keeps a group that arrived without details', () => {
        const breakdown = toCashflowBreakdown({ cashflows: { sales: { amount: 100 } } });

        expect(breakdown?.sales.amount).toBe(100);
        expect(breakdown?.sales.revenue).toBe(0);
        expect(breakdown?.services).toEqual([]);
    });
});

describe('serviceLabel', () => {
    it('names the services Ozon sends as slugs', () => {
        expect(serviceLabel('logistics')).toBe('Логистика');
        expect(serviceLabel('pay_per_click')).toBe('Оплата за клик');
        expect(serviceLabel('reverse_logistics')).toBe('Обратная логистика');
    });

    it('shows an unknown slug as it is rather than inventing a name', () => {
        expect(serviceLabel('some_new_fee')).toBe('some_new_fee');
    });
});

describe('mergeCostCandidates', () => {
    const keyOf = (offerId: string, sku: number) => (offerId.trim() ? offerId.trim() : String(sku));

    it('keeps the window rows and adds the month ones the window lacks', () => {
        // The live case: September's report held 22 articles while the loaded feed held 20,
        // and the two extra ones carried 8 units that could not be priced at all.
        const merged = mergeCostCandidates(
            [{ key: 'bagpendantbrown', label: 'Брелок', units: 26, payout: 4833.2 }],
            [
                {
                    sku: 1,
                    name: 'Лабубу',
                    offerId: 'headlabubupink',
                    units: 7,
                    returnedUnits: 1,
                    realized: 1400,
                    returned: 0,
                    loyalty: 0
                }
            ],
            keyOf
        );

        expect(merged).toHaveLength(2);
        const added = merged.find((row) => row.key === 'headlabubupink');
        expect(added?.label).toBe('Лабубу');
        // Sold units only: one of the seven came back.
        expect(added?.units).toBe(6);
    });

    it('does not duplicate a product that appears in both, keeping the window figures', () => {
        const merged = mergeCostCandidates(
            [{ key: 'case', label: 'Чехол', units: 69, payout: 73498 }],
            [
                {
                    sku: 2241890950,
                    name: 'Чехол',
                    offerId: 'case',
                    units: 80,
                    returnedUnits: 0,
                    realized: 90000,
                    returned: 0,
                    loyalty: 0
                }
            ],
            keyOf
        );

        expect(merged).toHaveLength(1);
        expect(merged[0].units).toBe(69);
    });

    it('sorts by units so the products that matter are first', () => {
        const merged = mergeCostCandidates(
            [{ key: 'small', label: 'A', units: 1, payout: 100 }],
            [
                {
                    sku: 2,
                    name: 'B',
                    offerId: 'big',
                    units: 50,
                    returnedUnits: 0,
                    realized: 5000,
                    returned: 0,
                    loyalty: 0
                }
            ],
            keyOf
        );

        expect(merged.map((row) => row.key)).toEqual(['big', 'small']);
    });

    it('falls back to the sku for a product with no article code', () => {
        const merged = mergeCostCandidates(
            [],
            [
                {
                    sku: 4242,
                    name: '',
                    offerId: '',
                    units: 3,
                    returnedUnits: 0,
                    realized: 300,
                    returned: 0,
                    loyalty: 0
                }
            ],
            keyOf
        );

        expect(merged[0].key).toBe('4242');
        expect(merged[0].label).toBe('4242');
    });

    it('drops a product whose every unit came back, leaving nothing to price', () => {
        const merged = mergeCostCandidates(
            [],
            [
                {
                    sku: 9,
                    name: 'Возврат',
                    offerId: 'returned',
                    units: 2,
                    returnedUnits: 2,
                    realized: 0,
                    returned: 500,
                    loyalty: 0
                }
            ],
            keyOf
        );

        // It is still listed, with zero units: the panel decides how to present it.
        expect(merged[0].units).toBe(0);
    });

    it('is empty-safe', () => {
        expect(mergeCostCandidates([], [], keyOf)).toEqual([]);
    });
});

describe('monthView', () => {
    const september = { month: '2026-09', rows: 342 };
    const october = { month: '2026-10', rows: 0 };

    it('shows data that belongs to the selected month', () => {
        const view = monthView('2026-09', '2026-09', september, null);

        expect(view.data).toBe(september);
        expect(view.error).toBeNull();
    });

    it('withholds data belonging to another month', () => {
        // The reader picked September; October's answer must not render.
        const view = monthView('2026-09', '2026-10', october, null);

        expect(view.data).toBeNull();
    });

    it('shows a failure that belongs to the selected month', () => {
        const error = { status: 500, message: 'boom' };
        const view = monthView('2026-09', '2026-09', null, error);

        expect(view.error).toBe(error);
        expect(view.reportMissing).toBe(false);
    });

    it('withholds a failure belonging to another month', () => {
        // This is the bug that was on screen: October's missing report was displayed under
        // the September heading.
        const view = monthView('2026-09', '2026-10', null, {
            status: 404,
            message: 'Report was not found'
        });

        expect(view.error).toBeNull();
        expect(view.reportMissing).toBe(false);
    });

    it('withholds a failure until a request has named a month', () => {
        const view = monthView('2026-09', null, null, { status: 404 });

        expect(view.error).toBeNull();
    });

    it('reports a missing report as a state rather than an error', () => {
        // Ozon answers 404 for the current month: its report appears once the month closes.
        const view = monthView('2026-10', '2026-10', null, {
            status: 404,
            message: 'Report was not found'
        });

        expect(view.reportMissing).toBe(true);
        expect(view.error?.status).toBe(404);
    });

    it('treats missing data as missing, not as zero', () => {
        const view = monthView('2026-09', '2026-09', undefined, undefined);

        expect(view.data).toBeNull();
        expect(view.error).toBeNull();
        expect(view.reportMissing).toBe(false);
    });
});

describe('taxableAmount', () => {
    const amounts = { payout: 130000, realized: 275000, cost: 120000 };

    it('charges a revenue regime on the realized revenue, not on the payout', () => {
        // The fixture's case: the realized figure is well above what was received. Taxing
        // the payout instead would understate the tax by the whole of Ozon's cut.
        expect(taxableAmount('realized', amounts)).toBeCloseTo(275000, 2);
    });

    it('charges the plain regime on the money received', () => {
        expect(taxableAmount('payout', amounts)).toBeCloseTo(130000, 2);
    });

    it('charges a profit regime on revenue less the cost', () => {
        expect(taxableAmount('margin', amounts)).toBeCloseTo(275000 - 120000, 2);
    });

    it('falls back to revenue for a profit regime with no cost, rather than to nothing', () => {
        expect(taxableAmount('margin', { ...amounts, cost: null })).toBeCloseTo(275000, 2);
    });
});

describe('profitAfterTaxAndCost', () => {
    it('charges the tax on the realized revenue while showing the money received first', () => {
        // The chain the seller asked for: деньги от Ozon − налог от реализованной выручки −
        // себестоимость. The first figure and the tax base are different amounts.
        const result = profitAfterTaxAndCost({
            payout: 130000,
            taxable: 275000,
            taxPercent: 7,
            cost: 120000
        });

        expect(result.payout).toBeCloseTo(130000, 2);
        expect(result.tax).toBeCloseTo(19250, 2);
        expect(result.net).toBeCloseTo(130000 - 19250 - 120000, 2);
    });

    it('can end in a loss without treating that as an error', () => {
        // A revenue-based tax is owed whatever Ozon's deductions left behind.
        const result = profitAfterTaxAndCost({
            payout: 100000,
            taxable: 250000,
            taxPercent: 7,
            cost: 90000
        });

        expect(result.tax).toBeCloseTo(17500, 2);
        expect(result.net).toBeCloseTo(-7500, 2);
        expect(result.netPercent).toBeCloseTo(-7.5, 2);
    });

    it('takes the tax off the money first, then the cost price', () => {
        const result = profitAfterTaxAndCost({
            payout: 100000,
            taxable: 100000,
            taxPercent: 7,
            cost: 30000
        });

        expect(result.tax).toBeCloseTo(7000, 2);
        expect(result.net).toBeCloseTo(63000, 2);
        expect(result.netPercent).toBeCloseTo(63, 2);
    });

    it('refuses to invent a net figure when the cost is unknown', () => {
        const result = profitAfterTaxAndCost({
            payout: 100000,
            taxable: 250000,
            taxPercent: 7,
            cost: null
        });

        expect(result.net).toBeNull();
        expect(result.netPercent).toBeNull();
        // The tax is still known, so it is reported: it does not depend on the cost.
        expect(result.tax).toBeCloseTo(17500, 2);
    });

    it('never charges a negative base and tolerates junk rates', () => {
        const loss = profitAfterTaxAndCost({
            payout: 100,
            taxable: -500,
            taxPercent: 7,
            cost: 0
        });
        expect(loss.tax).toBe(0);

        const junk = profitAfterTaxAndCost({
            payout: 100,
            taxable: 100,
            taxPercent: Number.NaN,
            cost: 0
        });
        expect(junk.tax).toBe(0);
    });

    it('reports a zero share instead of dividing by nothing', () => {
        const result = profitAfterTaxAndCost({
            payout: 0,
            taxable: 0,
            taxPercent: 7,
            cost: 0
        });

        expect(result.netPercent).toBeNull();
    });
});

describe('recentMonths', () => {
    it('lists the current month first, going back', () => {
        expect(recentMonths(new Date(2026, 9, 3), 4)).toEqual([
            '2026-10',
            '2026-09',
            '2026-08',
            '2026-07'
        ]);
    });

    it('crosses the year boundary', () => {
        expect(recentMonths(new Date(2026, 0, 15), 3)).toEqual(['2026-01', '2025-12', '2025-11']);
    });

    it('always returns at least one month', () => {
        expect(recentMonths(new Date(2026, 9, 3), 0)).toEqual(['2026-10']);
    });

    it('reaches back far enough for the reports the cabinet holds', () => {
        const months = recentMonths(new Date(2026, 9, 3), 24);

        expect(months).toHaveLength(24);
        expect(months).toContain('2026-01');
        expect(months).toContain('2025-11');
    });
});

describe('monthParts / monthBounds', () => {
    it('splits a key', () => {
        expect(monthParts('2026-09')).toEqual({ month: 9, year: 2026 });
        expect(monthParts('2026-13')).toBeNull();
        expect(monthParts('nonsense')).toBeNull();
    });

    it('gives the bounds the balance method requires', () => {
        expect(monthBounds('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
        expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
        expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
        expect(monthBounds('bad')).toBeNull();
    });
});
