import { describe, expect, it } from 'vitest';
import { buildActions, daysApart, STALE_AFTER_DAYS } from './actions';
import type { CapitalRow, CapitalSummary } from './capital';
import type { SkuEconomics } from './economics';
import type { FinanceSummary } from './pnl';

const NOW = new Date(2026, 8, 16, 12, 0, 0);

function capitalRow(over: Partial<CapitalRow> = {}): CapitalRow {
    return {
        key: 'ART-1',
        sku: 1,
        name: 'Товар',
        offerId: 'ART-1',
        stockUnits: 10,
        unitPrice: 1000,
        stockAtCost: 3000,
        stockAtRetail: 10000,
        demandPerDay: 1,
        daysOfCover: 10,
        health: 'ok',
        unitMargin: 500,
        dailyLostRevenue: 0,
        dailyLostProfit: 0,
        ...over
    };
}

function capital(over: Partial<CapitalSummary> = {}): CapitalSummary {
    return {
        stockAtCost: 3000,
        stockAtRetail: 10000,
        costedShare: 1,
        cogs: 900,
        grossProfit: 1500,
        periodDays: 31,
        turnoverRatio: 0.3,
        daysOfStock: 103,
        gmroi: 50,
        sellThrough: 23,
        frozenAtCost: null,
        frozenUnits: 0,
        frozenSkus: 0,
        lostRevenuePerDay: 0,
        lostProfitPerDay: null,
        lostRows: [],
        rows: [capitalRow()],
        ...over
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

function finance(over: Partial<FinanceSummary> = {}): FinanceSummary {
    return {
        netOrders: 1000,
        netCabinet: -100,
        net: 900,
        gross: 1400,
        orderLines: [],
        cabinetLines: [],
        daysWithData: 30,
        emptyDays: [],
        failedDays: [],
        lastDayWithData: '2026-09-15',
        accrualCount: 100,
        ...over
    };
}

function input(over: Partial<Parameters<typeof buildActions>[0]> = {}) {
    return {
        capital: capital(),
        economics: [economicsRow()],
        finance: finance(),
        costedShare: 1,
        soldCostCoverage: 1,
        now: NOW,
        ...over
    };
}

describe('daysApart', () => {
    it('counts whole days between a day string and a date', () => {
        expect(daysApart('2026-09-15', NOW)).toBe(1);
        expect(daysApart('2026-09-16', NOW)).toBe(0);
        expect(daysApart('2026-09-01', NOW)).toBe(15);
    });

    it('is null for an unparseable day', () => {
        expect(daysApart('', NOW)).toBeNull();
        expect(daysApart('nonsense', NOW)).toBeNull();
    });
});

describe('buildActions', () => {
    it('says nothing when everything is in order', () => {
        expect(buildActions(input())).toEqual([]);
    });

    it('leads with stockouts, priced per day', () => {
        const actions = buildActions(
            input({
                capital: capital({
                    lostRows: [capitalRow({ health: 'out', stockUnits: 0, dailyLostRevenue: 2000, dailyLostProfit: 1000 })],
                    lostRevenuePerDay: 2000,
                    lostProfitPerDay: 1000
                })
            })
        );

        expect(actions[0].kind).toBe('stockout');
        expect(actions[0].severity).toBe('high');
        expect(actions[0].amount).toBe(1000);
        expect(actions[0].basis).toBe('day');
    });

    it('falls back to revenue when the margin is unknown, and says so', () => {
        const actions = buildActions(
            input({
                capital: capital({
                    lostRows: [capitalRow({ health: 'out', stockUnits: 0, dailyLostRevenue: 2000 })],
                    lostRevenuePerDay: 2000,
                    lostProfitPerDay: null
                })
            })
        );

        expect(actions[0].amount).toBe(2000);
        expect(actions[0].detail).toContain('маржа станет известна');
    });

    it('raises low cover with the daily revenue it puts at risk', () => {
        const actions = buildActions(
            input({ capital: capital({ rows: [capitalRow({ health: 'critical', demandPerDay: 2 })] }) })
        );

        const low = actions.find((action) => action.kind === 'lowCover');
        expect(low?.amount).toBe(2000);
        expect(low?.basis).toBe('day');
    });

    it('prices loss-making products against the period', () => {
        const actions = buildActions(
            input({ economics: [economicsRow({ grossProfit: -400 })] })
        );

        const loss = actions.find((action) => action.kind === 'lossMaking');
        expect(loss?.amount).toBe(400);
        expect(loss?.basis).toBe('period');
    });

    it('reports frozen capital as a one-off amount', () => {
        const actions = buildActions(
            input({ capital: capital({ frozenAtCost: 41000, frozenSkus: 12, frozenUnits: 137 }) })
        );

        const frozen = actions.find((action) => action.kind === 'frozenCapital');
        expect(frozen?.amount).toBe(41000);
        expect(frozen?.basis).toBe('once');
    });

    it('alarms when accruals stop arriving', () => {
        const actions = buildActions(
            input({ finance: finance({ lastDayWithData: '2026-09-10' }) })
        );

        const stale = actions.find((action) => action.kind === 'staleFinance');
        expect(stale?.severity).toBe('high');
        expect(stale?.title).toContain('6 дн');
    });

    it('stays quiet about freshness while accruals are current', () => {
        const actions = buildActions(
            input({ finance: finance({ lastDayWithData: '2026-09-16' }) })
        );

        expect(actions.some((action) => action.kind === 'staleFinance')).toBe(false);
    });

    it('treats the boundary day as still fresh', () => {
        const day = new Date(NOW);
        day.setDate(day.getDate() - STALE_AFTER_DAYS);
        const lastDay = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

        const actions = buildActions(input({ finance: finance({ lastDayWithData: lastDay }) }));

        expect(actions.some((action) => action.kind === 'staleFinance')).toBe(false);
    });

    it('reports failed days ahead of staleness, since they are the cause', () => {
        const actions = buildActions(
            input({
                finance: finance({
                    failedDays: [{ date: '2026-09-15', error: 'obsolete method cannot be used' }],
                    lastDayWithData: '2026-09-01'
                })
            })
        );

        expect(actions[0].kind).toBe('failedFinance');
        expect(actions.some((action) => action.kind === 'staleFinance')).toBe(false);
    });

    it('asks for cost prices without inventing a loss', () => {
        const actions = buildActions(
            input({
                economics: [economicsRow({ grossProfit: null, costCoverage: 0 })],
                costedShare: 0,
                soldCostCoverage: 0
            })
        );

        const missing = actions.find((action) => action.kind === 'missingCosts');
        expect(missing?.amount).toBeNull();
        expect(missing?.basis).toBe('none');
        expect(missing?.severity).toBe('medium');
    });

    it('ranks by severity first, then by the amount at stake', () => {
        const actions = buildActions(
            input({
                capital: capital({
                    frozenAtCost: 100,
                    frozenSkus: 1,
                    lostRows: [capitalRow({ health: 'out', dailyLostRevenue: 10, dailyLostProfit: 10 })],
                    lostRevenuePerDay: 10,
                    lostProfitPerDay: 10
                }),
                economics: [economicsRow({ grossProfit: -5000 })]
            })
        );

        // Two high-severity actions, the larger amount first; the medium one last.
        expect(actions.map((action) => action.severity)).toEqual(['high', 'high', 'medium']);
        expect(actions[0].kind).toBe('lossMaking');
        expect(actions[1].kind).toBe('stockout');
        expect(actions[2].kind).toBe('frozenCapital');
    });

    it('points at the products involved, capped so the feed stays readable', () => {
        const rows = Array.from({ length: 9 }, (_, index) =>
            capitalRow({
                key: `ART-${index}`,
                sku: index,
                name: `Товар ${index}`,
                health: 'out',
                stockUnits: 0,
                dailyLostRevenue: 100,
                dailyLostProfit: 100
            })
        );

        const actions = buildActions(
            input({
                capital: capital({ lostRows: rows, lostRevenuePerDay: 900, lostProfitPerDay: 900 })
            })
        );

        expect(actions[0].skus).toHaveLength(5);
    });
});
