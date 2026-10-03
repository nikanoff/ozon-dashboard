import type {
    DashboardPosting,
    OzonFinancialProduct,
    OzonPostingProduct
} from './ozon_types';
import { productUnitPrice } from './stats';
import { costAt, type CostBook } from './costs';

/**
 * Money, as opposed to revenue.
 *
 * The dashboard used to headline the seller's price, which is what the *buyer*
 * pays. `financial_data` on the same free endpoint also carries what the seller
 * actually keeps, so this module exists to keep the two apart explicitly and to
 * never present one as the other.
 *
 * Every derived figure is `null` rather than `0` when its inputs are missing:
 * "Ozon did not report a payout" and "the payout was zero" are different facts, and
 * conflating them is how a dashboard ends up lying quietly.
 */

/**
 * Cost of one unit, as it applied on a given date.
 *
 * Dated on purpose: a margin for August has to use August's purchase price, so the
 * lookup receives the moment the line was ordered rather than "now".
 */
export type CostLookup = (offerId: string, sku: number, at: Date) => number | undefined;

/**
 * Reads commission from either shape Ozon uses.
 *
 * A live account returns `commission: { amount: -936, percent: 52 }`; the documentation
 * shows flat `commission_amount` / `commission_percent` fields. `amount` is negative in
 * the live response, and commission is a cost, so the magnitude is what callers want.
 */
export function readCommission(row: OzonFinancialProduct | undefined): {
    amount: number | null;
    percent: number | null;
} {
    const nested = row?.commission;
    const nestedAmount =
        typeof nested?.amount === 'number' && Number.isFinite(nested.amount)
            ? Math.abs(nested.amount)
            : null;
    const flatAmount =
        typeof row?.commission_amount === 'number' && Number.isFinite(row.commission_amount)
            ? Math.abs(row.commission_amount)
            : null;

    const amount = nestedAmount ?? flatAmount;
    const percent =
        typeof nested?.percent === 'number'
            ? nested.percent
            : typeof row?.commission_percent === 'number'
              ? row.commission_percent
              : null;

    return { amount, percent };
}

/** A posting line joined with its financial row. */
export interface EnrichedLine {
    /** Position in the posting's `products[]`. */
    index: number;
    sku: number;
    offerId: string;
    name: string;
    quantity: number;
    /** Seller price × quantity — the buyer's money. Always known. */
    gross: number;
    /** What the seller keeps for this line, when Ozon reported it. */
    payout: number | null;
    commission: number | null;
    commissionPercent: number | null;
    discountValue: number | null;
    oldPrice: number | null;
    actions: string[];
}

/**
 * Pairs `posting.products[]` with `posting.financial_data.products[]`.
 *
 * The two arrays describe the same lines but are keyed differently: the posting row
 * carries `sku`, the financial row carries `product_id`. The documented example has
 * them equal, which is not something to rely on. So:
 *
 *   1. equal lengths — pair by position, which is how Ozon returns them;
 *   2. otherwise match on `product_id === sku`, each financial row used once;
 *   3. anything left over keeps its gross value and gets `null` money.
 *
 * Rule 3 matters more than it looks: a partially reported order must still count
 * towards revenue, while its payout stays unknown instead of silently becoming zero.
 */
export function enrichLines(posting: DashboardPosting): EnrichedLine[] {
    const products: OzonPostingProduct[] = posting.products ?? [];
    const financial: OzonFinancialProduct[] = posting.financial_products ?? [];

    const byPosition = products.length === financial.length && products.length > 0;

    const claimed = new Set<number>();
    const moneyFor = (product: OzonPostingProduct, index: number) => {
        if (byPosition) return financial[index];

        const match = financial.findIndex(
            (row, rowIndex) =>
                !claimed.has(rowIndex) && row.product_id !== undefined && row.product_id === product.sku
        );
        if (match === -1) return undefined;

        claimed.add(match);
        return financial[match];
    };

    const numberOrNull = (value: number | undefined) =>
        typeof value === 'number' && Number.isFinite(value) ? value : null;

    return products.map((product, index) => {
        const money = moneyFor(product, index);
        const quantity = product.quantity || 1;
        const commission = readCommission(money);

        return {
            index,
            sku: product.sku,
            offerId: product.offer_id ?? '',
            name: product.name || product.offer_id || String(product.sku),
            quantity,
            gross: productUnitPrice(product) * quantity,
            payout: numberOrNull(money?.payout),
            commission: commission.amount,
            commissionPercent: commission.percent,
            discountValue: numberOrNull(money?.total_discount_value),
            oldPrice: numberOrNull(money?.old_price),
            actions: money?.actions ?? []
        };
    });
}

/** Posting-level money totals. */
export interface MoneySummary {
    /** Seller revenue before Ozon's deductions — the buyer's money, over every line. */
    gross: number;
    /** Commission Ozon keeps, over the settled lines. */
    commission: number;
    /** What the seller keeps, over the settled lines. */
    payout: number;
    units: number;
    /**
     * Price of the lines Ozon has calculated, so `commission + payout === settledGross`.
     *
     * The identity was checked against a live month: 389 of 396 delivered lines satisfy it
     * exactly, and the seven that do not are delivered but not yet calculated — they report
     * a real price with zero commission and zero payout.
     */
    settledGross: number;
    /**
     * Price of the lines Ozon has not calculated yet.
     *
     * A line counts as unsettled when it reports neither commission nor payout while carrying
     * a price: that is what an order in transit looks like, and also what a delivered order
     * looks like until the settlement runs. Their money is not yet determined, so they are
     * kept out of the ratios rather than counted as zero — which is what made the commission
     * rate read low and the three figures refuse to add up.
     */
    pendingGross: number;
    /** Lines with calculated money, and lines overall. */
    reportedLines: number;
    totalLines: number;
    /** `payout / settledGross`; `null` when nothing is settled. */
    payoutRatio: number | null;
    /** `commission / settledGross`; `null` when nothing is settled. */
    commissionRate: number | null;
    /** True when nothing is left uncalculated, so the ratios describe the whole period. */
    complete: boolean;
}

export function moneySummary(postings: DashboardPosting[]): MoneySummary {
    let gross = 0;
    let settledGross = 0;
    let pendingGross = 0;
    let commission = 0;
    let payout = 0;
    let units = 0;
    let reportedLines = 0;
    let totalLines = 0;

    for (const posting of postings) {
        for (const line of enrichLines(posting)) {
            totalLines += 1;
            units += line.quantity;
            gross += line.gross;

            if (line.payout === null) {
                pendingGross += line.gross;
                continue;
            }

            // Zero on both sides means Ozon has not run the settlement for this line yet.
            if (line.payout === 0 && (line.commission ?? 0) === 0) {
                pendingGross += line.gross;
                continue;
            }

            reportedLines += 1;
            settledGross += line.gross;
            payout += line.payout;
            commission += line.commission ?? 0;
        }
    }

    return {
        gross,
        commission,
        payout,
        units,
        settledGross,
        pendingGross,
        reportedLines,
        totalLines,
        payoutRatio: settledGross > 0 ? payout / settledGross : null,
        commissionRate: settledGross > 0 ? commission / settledGross : null,
        complete: totalLines > 0 && pendingGross === 0
    };
}

/**
 * The commission rate per article, over the loaded period.
 *
 * Ozon's rate is not one number for the account: measured over a September of 20 articles it
 * ran from 17 % to 52 %, while the account-wide blend read 51 % because two articles carried
 * most of the revenue. The blend answers nothing a seller can price against; the per-article
 * rate does.
 *
 * A period figure, not a property of the article. Within that one month an article's rate
 * looked stable, but Ozon revises commission rates, so the value here describes the loaded
 * days and no more — do not treat it as the rate that will apply next month.
 *
 * Measured on settled lines only. An order Ozon has not calculated reports a zero commission,
 * and averaging those in would pull every article's rate towards zero.
 */
export interface CommissionSpread {
    /** `costKey` of the article to its commission share, 0..1. */
    byKey: Map<string, number>;
    /** Lowest and highest article rate, `null` when nothing is settled. */
    min: number | null;
    max: number | null;
    /** Median article rate — the middle one, not a weighted average. */
    median: number | null;
    /** How many articles the rates were measured over. */
    articles: number;
}

export function commissionSpread(postings: DashboardPosting[]): CommissionSpread {
    const totals = new Map<string, { gross: number; commission: number }>();

    for (const posting of postings) {
        if (posting.status === 'cancelled') continue;

        for (const line of enrichLines(posting)) {
            const settled =
                line.payout !== null && (line.payout !== 0 || (line.commission ?? 0) !== 0);
            if (!settled) continue;

            const key = costKey(line.offerId, line.sku);
            const entry = totals.get(key) ?? { gross: 0, commission: 0 };
            entry.gross += line.gross;
            entry.commission += line.commission ?? 0;
            totals.set(key, entry);
        }
    }

    const byKey = new Map<string, number>();
    for (const [key, entry] of totals) {
        if (entry.gross > 0) byKey.set(key, entry.commission / entry.gross);
    }

    const rates = [...byKey.values()].sort((a, b) => a - b);

    return {
        byKey,
        min: rates.length > 0 ? rates[0] : null,
        max: rates.length > 0 ? rates[rates.length - 1] : null,
        median: rates.length > 0 ? rates[Math.floor(rates.length / 2)] : null,
        articles: rates.length
    };
}

/** Unit economics for one SKU. */
export interface SkuEconomics {    /** Cost lookup key: the seller's article, falling back to the SKU. */
    key: string;
    sku: number;
    offerId: string;
    name: string;
    units: number;
    /** Buyer money. */
    gross: number;
    commission: number;
    /** Seller money, over the units Ozon reported. */
    payout: number;
    /** Cost of the units whose cost is known; `null` when none is. */
    cogs: number | null;
    /**
     * Payout minus cost of goods sold.
     *
     * `null` unless *every* unit has both a reported payout and a known cost —
     * a partial figure would look like a real loss when it is only missing data.
     */
    grossProfit: number | null;
    /** `grossProfit / payout`; `null` without a complete cost. */
    marginPercent: number | null;
    payoutRatio: number | null;
    /** Share of units with a known cost, 0..1. */
    costCoverage: number;
    /** Share of units with a reported payout, 0..1. */
    payoutCoverage: number;
    /** Reported lines behind this row, and lines overall. */
    reportedLines: number;
    totalLines: number;
}

/** Stable key for a product across postings and stock rows. */
export function costKey(offerId: string | undefined, sku: number): string {
    return offerId && offerId.trim() ? offerId.trim() : String(sku);
}

/**
 * Adapts a stored cost book into the lookup the aggregations expect.
 *
 * Kept here rather than in the store so the dated resolution stays testable without
 * touching `localStorage`.
 */
export function costBookLookup(book: CostBook): CostLookup {
    return (offerId, sku, at) => costAt(book, costKey(offerId, sku), at)?.unitCost;
}

/**
 * Aggregates a SKU's sales into margin terms.
 *
 * Without a cost the row still reports money (payout) but leaves `grossProfit`
 * `null`, so the interface can distinguish "not profitable" from "not known".
 */
export function skuEconomics(
    postings: DashboardPosting[],
    costs: CostLookup
): SkuEconomics[] {
    interface Accruing extends SkuEconomics {
        costedUnits: number;
        reportedUnits: number;
        knownCogs: number;
    }

    const rows = new Map<string, Accruing>();

    for (const posting of postings) {
        const at = new Date(posting.created_at);

        for (const line of enrichLines(posting)) {
            const key = costKey(line.offerId, line.sku);
            const row =
                rows.get(key) ??
                ({
                    key,
                    sku: line.sku,
                    offerId: line.offerId,
                    name: line.name,
                    units: 0,
                    gross: 0,
                    commission: 0,
                    payout: 0,
                    cogs: null,
                    grossProfit: null,
                    marginPercent: null,
                    payoutRatio: null,
                    costCoverage: 0,
                    payoutCoverage: 0,
                    reportedLines: 0,
                    totalLines: 0,
                    costedUnits: 0,
                    reportedUnits: 0,
                    knownCogs: 0
                } satisfies Accruing);

            row.units += line.quantity;
            row.gross += line.gross;
            row.totalLines += 1;
            if (line.name && row.name === row.offerId) row.name = line.name;

            const unitCost = costs(line.offerId, line.sku, at);
            if (typeof unitCost === 'number' && Number.isFinite(unitCost)) {
                row.costedUnits += line.quantity;
                row.knownCogs += unitCost * line.quantity;
            }

            if (line.payout !== null) {
                row.payout += line.payout;
                row.commission += line.commission ?? 0;
                row.reportedLines += 1;
                row.reportedUnits += line.quantity;
            }

            rows.set(key, row);
        }
    }

    return [...rows.values()]
        .map((row) => {
            const costCoverage = row.units > 0 ? row.costedUnits / row.units : 0;
            const payoutCoverage = row.units > 0 ? row.reportedUnits / row.units : 0;
            const cogs = row.costedUnits > 0 ? row.knownCogs : null;

            // Both halves have to be complete before a profit figure means anything.
            const complete = costCoverage === 1 && payoutCoverage === 1 && row.units > 0;
            const grossProfit = complete && cogs !== null ? row.payout - cogs : null;

            const result: SkuEconomics = {
                key: row.key,
                sku: row.sku,
                offerId: row.offerId,
                name: row.name,
                units: row.units,
                gross: row.gross,
                commission: row.commission,
                payout: row.payout,
                cogs,
                grossProfit,
                marginPercent:
                    grossProfit === null || row.payout <= 0
                        ? null
                        : (grossProfit / row.payout) * 100,
                payoutRatio: row.gross > 0 ? row.payout / row.gross : null,
                costCoverage,
                payoutCoverage,
                reportedLines: row.reportedLines,
                totalLines: row.totalLines
            };

            return result;
        })
        .sort((a, b) => b.payout - a.payout || b.gross - a.gross);
}

export type AbcGrade = 'A' | 'B' | 'C';

export interface AbcRow {
    key: string;
    label: string;
    value: number;
    /** Share of the total, in percent. */
    share: number;
    /** Running share including this row, in percent. */
    cumulativeShare: number;
    grade: AbcGrade;
}

/**
 * Classic ABC split by a chosen value.
 *
 * The dashboard always sorted assortment by revenue, which ranks a high-turnover,
 * thin-margin item above the one that actually funds the business. Passing payout or
 * gross profit as `valueOf` is the point of this function.
 */
export function abcAnalysis(
    entries: { key: string; label: string; value: number }[],
    thresholds: [number, number] = [80, 95]
): AbcRow[] {
    const ranked = entries
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value);

    const total = ranked.reduce((sum, entry) => sum + entry.value, 0);
    if (total <= 0) return [];

    let running = 0;

    return ranked.map((entry) => {
        const share = (entry.value / total) * 100;
        // Classify by the share accumulated *before* this row: a row that alone
        // crosses a boundary belongs to the class it enters, otherwise one dominant
        // product would be graded C for carrying the whole catalogue.
        const grade: AbcGrade =
            running < thresholds[0]
                ? 'A'
                : running < thresholds[1]
                  ? 'B'
                  : 'C';

        running += share;

        return {
            key: entry.key,
            label: entry.label,
            value: entry.value,
            share,
            cumulativeShare: running,
            grade
        };
    });
}

/**
 * Price at which a unit stops losing money.
 *
 * `payoutRatio` is what the seller keeps per rouble of price; dividing the cost by it
 * answers "what must the buyer pay for me to break even". Returns `null` when the
 * ratio is unknown or non-positive — a zero ratio has no break-even price at all.
 */
export function breakEvenPrice(
    unitCost: number | null,
    payoutRatio: number | null
): number | null {
    if (unitCost === null || !Number.isFinite(unitCost)) return null;
    if (payoutRatio === null || payoutRatio <= 0) return null;

    return unitCost / payoutRatio;
}

/** Rows whose money does not cover their cost. */
export function lossMaking(rows: SkuEconomics[]): SkuEconomics[] {
    return rows.filter(
        (row) => row.grossProfit !== null && row.grossProfit < 0
    );
}
