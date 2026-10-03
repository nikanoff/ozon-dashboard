import type { InventoryInsights, InventoryRow } from './inventory';
import type { SkuEconomics } from './economics';

/**
 * Working capital and efficiency: how much money is tied up in stock, how fast it comes
 * back, and what the empty shelves are costing every day.
 *
 * Everything here is computed from data the dashboard already holds — postings, stock
 * rows and the seller's own cost prices — so no extra Ozon call is involved. That
 * matters because the one method that reports Ozon's own turnover grades is limited to a
 * single request per minute.
 *
 * Where a figure rests on an assumption it says so in the number rather than in a
 * footnote:
 *
 *   - turnover and GMROI divide by the *current* stock value, because no stock history is
 *     stored yet. They are labelled as such in the UI;
 *   - lost sales are reported **per day**, not extrapolated over an invented outage
 *     length. Nobody knows how long a shelf has been empty, and a fabricated total would
 *     be worse than an honest rate.
 */

/** Rows whose stock is not coming back at the current pace. */
const SLOW_HEALTH = new Set(['dead', 'overstock']);

export interface CapitalRow {
    /** Cost-book key, matching `SkuEconomics.key`. */
    key: string;
    sku: number;
    name: string;
    offerId: string;
    stockUnits: number;
    /** Last known selling price of one unit. */
    unitPrice: number;
    /** Stock valued at purchase cost; `null` when the cost is unknown. */
    stockAtCost: number | null;
    /** Stock valued at the last selling price, for contrast. */
    stockAtRetail: number;
    demandPerDay: number;
    daysOfCover: number | null;
    health: InventoryRow['health'];
    /** Margin on one unit, when both payout and cost are known. */
    unitMargin: number | null;
    /** Revenue the empty shelf forgoes each day, at the observed demand. */
    dailyLostRevenue: number;
    /** Margin the empty shelf forgoes each day. */
    dailyLostProfit: number | null;
}

export interface CapitalSummary {
    /** Stock at purchase cost — the working capital actually tied up. */
    stockAtCost: number | null;
    stockAtRetail: number;
    /** Share of stock units whose cost is known, 0..1. */
    costedShare: number;
    /** Cost of goods sold over the period. */
    cogs: number | null;
    /** Gross profit over the period. */
    grossProfit: number | null;
    periodDays: number;
    /**
     * Inventory turnover: cost of goods sold divided by stock at cost.
     *
     * Uses the current stock value as the denominator, so it is exact only while stock
     * is roughly steady.
     */
    turnoverRatio: number | null;
    /** Days the current stock lasts at the period's rate of sale. */
    daysOfStock: number | null;
    /** Gross margin return on inventory investment, in percent. */
    gmroi: number | null;
    /** Units sold as a share of units sold plus units still on hand, in percent. */
    sellThrough: number | null;
    /** Capital sitting in slow-moving stock, in purchase money. */
    frozenAtCost: number | null;
    frozenUnits: number;
    frozenSkus: number;
    /** Revenue forgone each day by every out-of-stock item that still has demand. */
    lostRevenuePerDay: number;
    /** The same, in margin. `null` when unit costs are missing. */
    lostProfitPerDay: number | null;
    /** Out-of-stock SKUs that still show demand, worst first. */
    lostRows: CapitalRow[];
    rows: CapitalRow[];
}

export interface CapitalInput {
    inventory: InventoryInsights;
    economics: SkuEconomics[];
    /** Unit cost resolved for a product, in today's prices. */
    unitCost: (offerId: string, sku: number) => number | undefined;
    periodDays: number;
}

export function capitalSummary({
    inventory,
    economics,
    unitCost,
    periodDays
}: CapitalInput): CapitalSummary {
    const marginByKey = new Map(
        economics.map((row) => [row.key, row.units > 0 && row.grossProfit !== null
            ? row.grossProfit / row.units
            : null])
    );

    const rows: CapitalRow[] = inventory.rows.map((row) => {
        const key = row.offerId && row.offerId.trim() ? row.offerId.trim() : String(row.sku);
        const cost = unitCost(row.offerId, row.sku);
        const known = typeof cost === 'number' && Number.isFinite(cost);
        const unitMargin = marginByKey.get(key) ?? null;

        // A shelf with demand but nothing on it forgoes sales every day it stays empty.
        const empty = row.demandPerDay > 0 && row.total <= 0;

        return {
            key,
            sku: row.sku,
            name: row.name,
            offerId: row.offerId,
            stockUnits: row.total,
            unitPrice: row.unitPrice,
            stockAtCost: known ? row.total * cost : null,
            stockAtRetail: row.total * row.unitPrice,
            demandPerDay: row.demandPerDay,
            daysOfCover: row.daysOfCover,
            health: row.health,
            unitMargin,
            dailyLostRevenue: empty ? row.demandPerDay * row.unitPrice : 0,
            dailyLostProfit:
                empty && unitMargin !== null ? row.demandPerDay * unitMargin : null
        };
    });

    const stockAtCost = rows.reduce(
        (sum, row) => (row.stockAtCost === null ? sum : sum + row.stockAtCost),
        0
    );
    const costedUnits = rows.reduce(
        (sum, row) => (row.stockAtCost === null ? sum : sum + row.stockUnits),
        0
    );
    const totalUnits = rows.reduce((sum, row) => sum + row.stockUnits, 0);

    // A partially costed stock cannot produce an honest turnover or GMROI.
    const fullyCosted = totalUnits > 0 && costedUnits === totalUnits;
    const cogs = economics.reduce(
        (sum, row) => (row.cogs === null ? sum : sum + row.cogs),
        0
    );
    const grossProfit = economics.reduce(
        (sum, row) => (row.grossProfit === null ? sum : sum + row.grossProfit),
        0
    );
    const allCosted =
        economics.length > 0 && economics.every((row) => row.grossProfit !== null);

    const frozen = rows.filter((row) => SLOW_HEALTH.has(row.health));
    const frozenAtCost = frozen.reduce(
        (sum, row) => (row.stockAtCost === null ? sum : sum + row.stockAtCost),
        0
    );

    const soldUnits = economics.reduce((sum, row) => sum + row.units, 0);
    const lostRows = rows
        .filter((row) => row.dailyLostRevenue > 0)
        .sort((a, b) => b.dailyLostRevenue - a.dailyLostRevenue);

    const lostProfitPerDay = lostRows.every((row) => row.dailyLostProfit !== null)
        ? lostRows.reduce((sum, row) => sum + (row.dailyLostProfit ?? 0), 0)
        : null;

    const canDivide = fullyCosted && stockAtCost > 0 && allCosted;

    return {
        stockAtCost: costedUnits > 0 ? stockAtCost : null,
        stockAtRetail: rows.reduce((sum, row) => sum + row.stockAtRetail, 0),
        costedShare: totalUnits > 0 ? costedUnits / totalUnits : 0,
        cogs: allCosted ? cogs : null,
        grossProfit: allCosted ? grossProfit : null,
        periodDays,
        turnoverRatio: canDivide && cogs !== null ? cogs / stockAtCost : null,
        daysOfStock:
            canDivide && cogs !== null && cogs > 0
                ? (stockAtCost / cogs) * periodDays
                : null,
        gmroi: canDivide && grossProfit !== null ? (grossProfit / stockAtCost) * 100 : null,
        sellThrough:
            soldUnits + totalUnits > 0
                ? (soldUnits / (soldUnits + totalUnits)) * 100
                : null,
        frozenAtCost: frozen.some((row) => row.stockAtCost !== null) ? frozenAtCost : null,
        frozenUnits: frozen.reduce((sum, row) => sum + row.stockUnits, 0),
        frozenSkus: frozen.length,
        lostRevenuePerDay: lostRows.reduce((sum, row) => sum + row.dailyLostRevenue, 0),
        lostProfitPerDay,
        lostRows,
        rows
    };
}

/** How many units to order to cover `coverDays` at the observed demand. */
export function suggestedOrder(
    demandPerDay: number,
    stockUnits: number,
    coverDays: number
): number {
    if (!Number.isFinite(demandPerDay) || demandPerDay <= 0) return 0;

    const target = demandPerDay * coverDays;
    return Math.max(0, Math.ceil(target - stockUnits));
}
