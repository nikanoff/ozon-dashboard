import type {
    DashboardPosting,
    OzonFinancialProduct,
    OzonPostingProduct
} from './ozon_types';
import { productUnitPrice } from './stats';

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

/** Cost of one unit, keyed by the seller's own article where possible. */
export type CostLookup = (offerId: string, sku: number) => number | undefined;

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

        return {
            index,
            sku: product.sku,
            offerId: product.offer_id ?? '',
            name: product.name || product.offer_id || String(product.sku),
            quantity,
            gross: productUnitPrice(product) * quantity,
            payout: numberOrNull(money?.payout),
            commission: numberOrNull(money?.commission_amount),
            commissionPercent: numberOrNull(money?.commission_percent),
            discountValue: numberOrNull(money?.total_discount_value),
            oldPrice: numberOrNull(money?.old_price),
            actions: money?.actions ?? []
        };
    });
}

/** Posting-level money totals. */
export interface MoneySummary {
    /** Seller revenue before Ozon's deductions — the buyer's money. */
    gross: number;
    /** Commission Ozon keeps, over the lines that reported it. */
    commission: number;
    /** What the seller keeps, over the lines that reported it. */
    payout: number;
    /** Discount given away, over the lines that reported it. */
    discountValue: number;
    units: number;
    /** Lines with a reported payout, and lines overall. */
    reportedLines: number;
    totalLines: number;
    /** `payout / gross` over reported lines; `null` when nothing was reported. */
    payoutRatio: number | null;
    /** `commission / gross` over reported lines; `null` when nothing was reported. */
    commissionRate: number | null;
    /** True when every line reported money, so the ratios describe the whole period. */
    complete: boolean;
}

export function moneySummary(postings: DashboardPosting[]): MoneySummary {
    let gross = 0;
    let reportedGross = 0;
    let commission = 0;
    let payout = 0;
    let discountValue = 0;
    let units = 0;
    let reportedLines = 0;
    let totalLines = 0;

    for (const posting of postings) {
        for (const line of enrichLines(posting)) {
            totalLines += 1;
            units += line.quantity;
            gross += line.gross;

            if (line.payout === null) continue;

            reportedLines += 1;
            reportedGross += line.gross;
            payout += line.payout;
            commission += line.commission ?? 0;
            discountValue += line.discountValue ?? 0;
        }
    }

    return {
        gross,
        commission,
        payout,
        discountValue,
        units,
        reportedLines,
        totalLines,
        payoutRatio: reportedGross > 0 ? payout / reportedGross : null,
        commissionRate: reportedGross > 0 ? commission / reportedGross : null,
        complete: totalLines > 0 && reportedLines === totalLines
    };
}

/** Unit economics for one SKU. */
export interface SkuEconomics {
    /** Cost lookup key: the seller's article, falling back to the SKU. */
    key: string;
    sku: number;
    offerId: string;
    name: string;
    units: number;
    /** Buyer money. */
    gross: number;
    commission: number;
    /** Seller money. */
    payout: number;
    /** Cost of the units sold, when a unit cost is known. */
    cogs: number | null;
    /** Payout minus cost of goods sold. */
    grossProfit: number | null;
    /** `grossProfit / payout`; `null` without a cost. */
    marginPercent: number | null;
    payoutRatio: number | null;
    /** Reported lines behind this row, and lines overall. */
    reportedLines: number;
    totalLines: number;
}

/** Stable key for a product across postings and stock rows. */
export function costKey(offerId: string | undefined, sku: number): string {
    return offerId && offerId.trim() ? offerId.trim() : String(sku);
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
    const rows = new Map<string, SkuEconomics>();

    for (const posting of postings) {
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
                    reportedLines: 0,
                    totalLines: 0
                } satisfies SkuEconomics);

            row.units += line.quantity;
            row.gross += line.gross;
            row.totalLines += 1;
            if (line.name && row.name === row.offerId) row.name = line.name;

            if (line.payout !== null) {
                row.payout += line.payout;
                row.commission += line.commission ?? 0;
                row.reportedLines += 1;
            }

            rows.set(key, row);
        }
    }

    const unitCosts = new Map<string, number | undefined>();

    return [...rows.values()]
        .map((row) => {
            if (!unitCosts.has(row.key)) {
                unitCosts.set(row.key, costs(row.offerId, row.sku));
            }
            const unitCost = unitCosts.get(row.key);

            const cogs =
                typeof unitCost === 'number' && Number.isFinite(unitCost)
                    ? unitCost * row.units
                    : null;
            const grossProfit = cogs === null ? null : row.payout - cogs;

            return {
                ...row,
                cogs,
                grossProfit,
                marginPercent:
                    grossProfit === null || row.payout <= 0
                        ? null
                        : (grossProfit / row.payout) * 100,
                payoutRatio: row.gross > 0 ? row.payout / row.gross : null
            };
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
