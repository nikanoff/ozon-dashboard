import { describe, expect, it } from 'vitest';
import { capitalSummary, type CapitalInput } from './capital';
import type { InventoryInsights, InventoryRow } from './inventory';
import type { SkuEconomics } from './economics';

function inventoryRow(over: Partial<InventoryRow> = {}): InventoryRow {
    return {
        sku: 1,
        name: 'Товар',
        offerId: 'ART-1',
        present: 10,
        reserved: 0,
        total: 10,
        demandPerDay: 1,
        daysOfCover: 10,
        revenue: 3000,
        unitPrice: 1000,
        health: 'ok',
        ...over
    };
}

function insights(rows: InventoryRow[]): InventoryInsights {
    return {
        rows,
        outOfStock: rows.filter((row) => row.health === 'out'),
        critical: rows.filter((row) => row.health === 'critical'),
        low: rows.filter((row) => row.health === 'low'),
        overstock: rows.filter((row) => row.health === 'overstock'),
        dead: rows.filter((row) => row.health === 'dead'),
        inventoryValue: 0,
        totalPresent: rows.reduce((sum, row) => sum + row.present, 0),
        totalReserved: 0
    };
}

function economicsRow(over: Partial<SkuEconomics> = {}): SkuEconomics {
    return {
        key: 'ART-1',
        sku: 1,
        offerId: 'ART-1',
        name: 'Товар',
        units: 3,
        gross: 3000,
        commission: 600,
        payout: 2400,
        cogs: 900,
        grossProfit: 1500,
        marginPercent: 62.5,
        payoutRatio: 0.8,
        costCoverage: 1,
        payoutCoverage: 1,
        reportedLines: 3,
        totalLines: 3,
        ...over
    };
}

function input(over: Partial<CapitalInput> = {}): CapitalInput {
    return {
        inventory: insights([inventoryRow()]),
        economics: [economicsRow()],
        unitCost: () => 300,
        periodDays: 31,
        ...over
    };
}

describe('capitalSummary', () => {
    it('values stock at cost and at retail separately', () => {
        const summary = capitalSummary(input());

        // 10 units at 300 cost, 10 at 1000 retail.
        expect(summary.stockAtCost).toBe(3000);
        expect(summary.stockAtRetail).toBe(10000);
        expect(summary.costedShare).toBe(1);
    });

    it('computes turnover from cost of goods sold over stock at cost', () => {
        const summary = capitalSummary(input());

        expect(summary.cogs).toBe(900);
        expect(summary.turnoverRatio).toBeCloseTo(900 / 3000);
        // 3000 of stock against 900 of monthly cost turns in ~103 days.
        expect(summary.daysOfStock).toBeCloseTo((3000 / 900) * 31);
    });

    it('computes GMROI as gross profit over stock at cost, in percent', () => {
        const summary = capitalSummary(input());

        expect(summary.gmroi).toBeCloseTo((1500 / 3000) * 100);
    });

    it('computes sell-through from units sold against units on hand', () => {
        const summary = capitalSummary(input());

        expect(summary.sellThrough).toBeCloseTo((3 / (3 + 10)) * 100);
    });

    it('withholds turnover and GMROI when the stock is only partly costed', () => {
        const summary = capitalSummary(
            input({
                inventory: insights([
                    inventoryRow(),
                    inventoryRow({ sku: 2, offerId: 'ART-2', total: 5 })
                ]),
                // Only ART-1 has a cost, so part of the stock is unvalued.
                unitCost: (offerId) => (offerId === 'ART-1' ? 300 : undefined)
            })
        );

        expect(summary.costedShare).toBeCloseTo(10 / 15);
        expect(summary.turnoverRatio).toBeNull();
        expect(summary.gmroi).toBeNull();
        // The costed part is still reported, so the number is not simply hidden.
        expect(summary.stockAtCost).toBe(3000);
    });

    it('withholds profit-based figures when a product has no cost', () => {
        const summary = capitalSummary(
            input({ economics: [economicsRow({ cogs: null, grossProfit: null })] })
        );

        expect(summary.cogs).toBeNull();
        expect(summary.grossProfit).toBeNull();
        expect(summary.gmroi).toBeNull();
    });

    it('reports frozen capital for slow-moving stock', () => {
        const summary = capitalSummary(
            input({
                inventory: insights([
                    inventoryRow({ health: 'dead', demandPerDay: 0, total: 40, daysOfCover: null }),
                    inventoryRow({ sku: 2, offerId: 'ART-2', health: 'overstock', total: 60 })
                ])
            })
        );

        // 100 units at 300.
        expect(summary.frozenAtCost).toBe(30000);
        expect(summary.frozenUnits).toBe(100);
        expect(summary.frozenSkus).toBe(2);
    });

    it('reports lost sales per day, not over an invented outage length', () => {
        const summary = capitalSummary(
            input({
                inventory: insights([
                    inventoryRow({ health: 'out', total: 0, present: 0, demandPerDay: 2, unitPrice: 1000 })
                ])
            })
        );

        // 2 units a day at 1000, and a margin of 1500/3 = 500 per unit.
        expect(summary.lostRevenuePerDay).toBe(2000);
        expect(summary.lostProfitPerDay).toBe(1000);
        expect(summary.lostRows).toHaveLength(1);
    });

    it('does not count an out-of-stock item that has no demand', () => {
        const summary = capitalSummary(
            input({
                inventory: insights([
                    inventoryRow({ health: 'dead', total: 0, present: 0, demandPerDay: 0 })
                ])
            })
        );

        expect(summary.lostRevenuePerDay).toBe(0);
        expect(summary.lostRows).toEqual([]);
    });

    it('leaves lost profit unknown when the margin is unknown', () => {
        const summary = capitalSummary(
            input({
                inventory: insights([
                    inventoryRow({ health: 'out', total: 0, present: 0, demandPerDay: 2 })
                ]),
                economics: [economicsRow({ grossProfit: null })]
            })
        );

        expect(summary.lostRevenuePerDay).toBe(2000);
        expect(summary.lostProfitPerDay).toBeNull();
    });

    it('matches economics to inventory by the seller article', () => {
        const summary = capitalSummary(
            input({
                inventory: insights([inventoryRow({ offerId: 'ART-9', sku: 9 })]),
                economics: [economicsRow({ key: 'ART-9', units: 4, grossProfit: 800 })]
            })
        );

        expect(summary.rows[0].unitMargin).toBeCloseTo(200);
    });

    it('falls back to the SKU when the article is empty', () => {
        const summary = capitalSummary(
            input({
                inventory: insights([inventoryRow({ offerId: '', sku: 77 })]),
                economics: [economicsRow({ key: '77', units: 2, grossProfit: 400 })]
            })
        );

        expect(summary.rows[0].key).toBe('77');
        expect(summary.rows[0].unitMargin).toBeCloseTo(200);
    });

    it('is empty-safe', () => {
        const summary = capitalSummary({
            inventory: insights([]),
            economics: [],
            unitCost: () => undefined,
            periodDays: 31
        });

        expect(summary.stockAtCost).toBeNull();
        expect(summary.turnoverRatio).toBeNull();
        expect(summary.sellThrough).toBeNull();
        expect(summary.lostRevenuePerDay).toBe(0);
        expect(summary.rows).toEqual([]);
    });

    it('does not divide by a zero-cost stock', () => {
        const summary = capitalSummary(
            input({ inventory: insights([inventoryRow({ total: 0, present: 0 })]) })
        );

        expect(summary.turnoverRatio).toBeNull();
        expect(summary.gmroi).toBeNull();
    });
});
