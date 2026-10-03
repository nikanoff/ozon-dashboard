/**
 * Monthly figures from Ozon's realization report and balance.
 *
 * This is what makes the dashboard able to speak about months that the order feed cannot
 * reach. The orders endpoint only ever returns a bounded recent window, which is why the
 * period selector could offer nothing older than that window; the realization report is a
 * monthly document that the API serves for any month, and its totals were checked against
 * the seller's own xlsx row by row.
 *
 * Field names were verified against that file, which is why the mapping is stated here
 * rather than guessed:
 *
 *   `delivery_commission.amount`  = «Реализовано на сумму»
 *   `return_commission.amount`    = «Возвращено на сумму»
 *   `bank_coinvestment`           = «Выплаты по механикам лояльности партнёров»
 *
 * `commission` inside the realization report is zero for every row, so the report cannot
 * supply the sale commission; that comes from the order cards or the accruals. `bonus` and
 * `standard_fee` have no verified meaning and are deliberately not surfaced.
 */

/** One line of the realization report, reduced to what the interface uses. */
export interface RealizationSku {
    sku: number;
    name: string;
    offerId: string;
    units: number;
    returnedUnits: number;
    /** Money realized at the seller's price. */
    realized: number;
    /** Value of what customers sent back. */
    returned: number;
    /** Partner loyalty payouts on realized items. */
    loyalty: number;
}

export interface RealizationMonth {
    /** Lines in the report — one per realized item, not per order. */
    rows: number;
    units: number;
    returnedUnits: number;
    realized: number;
    returned: number;
    /** Realized minus returned: the figure the report itself totals. */
    net: number;
    loyalty: number;
    loyaltyReturned: number;
    /** What the seller is actually paid for loyalty mechanics. */
    loyaltyNet: number;
    perSku: RealizationSku[];
}

export interface BalanceSummary {
    /** Money on the account at the start of the period. */
    opening: number | null;
    /** Money on the account at the end of the period. */
    closing: number | null;
    /** What Ozon charged and credited over the period — the authoritative net. */
    accrued: number | null;
    /** What was actually transferred out over the period. */
    paid: number | null;
}

/** One week of the cash-flow statement: the settlement breakdown. */
export interface WeekFlow {
    from: string;
    to: string;
    orders: number;
    returns: number;
    commission: number;
    services: number;
    delivery: number;
    /** Sum of the row, which is what lands in the account for that week. */
    net: number;
}

export interface MonthFinance {
    month: string;
    realization: RealizationMonth;
    balance: BalanceSummary | null;
    /** The labelled breakdown behind the balance, when Ozon sends it. */
    cashflows: CashflowBreakdown | null;
    weeks: WeekFlow[];
    fetchedAt: string;
}

function numberOf(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

function money(value: unknown): number {
    return numberOf(value) ?? 0;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Reads the realization report into monthly totals and a per-SKU rollup. */
export function toRealizationMonth(raw: unknown): RealizationMonth {
    const root = ((raw ?? {}) as { result?: unknown }).result ?? raw;
    const rows = Array.isArray((root as { rows?: unknown[] })?.rows)
        ? ((root as { rows: unknown[] }).rows as unknown[])
        : [];

    const month: RealizationMonth = {
        rows: rows.length,
        units: 0,
        returnedUnits: 0,
        realized: 0,
        returned: 0,
        net: 0,
        loyalty: 0,
        loyaltyReturned: 0,
        loyaltyNet: 0,
        perSku: []
    };

    const bySku = new Map<number, RealizationSku>();

    for (const entry of rows) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as {
            item?: { sku?: unknown; name?: unknown; offer_id?: unknown };
            seller_price_per_instance?: unknown;
            delivery_commission?: Record<string, unknown>;
            return_commission?: Record<string, unknown> | null;
        };

        const delivery = row.delivery_commission ?? {};
        const returned = row.return_commission ?? null;

        // `quantity` is absent on some lines; one unit per line is the safe reading, and the
        // per-SKU unit totals were checked against the report file.
        const units = numberOf(delivery.quantity) ?? 1;
        const realized = money(delivery.amount);
        const loyalty = money(delivery.bank_coinvestment);

        const returnedUnits = returned ? (numberOf(returned.quantity) ?? 0) : 0;
        const returnedSum = returned ? money(returned.amount) : 0;
        const loyaltyReturned = returned ? money(returned.bank_coinvestment) : 0;

        month.units += units;
        month.returnedUnits += returnedUnits;
        month.realized += realized;
        month.returned += returnedSum;
        month.loyalty += loyalty;
        month.loyaltyReturned += loyaltyReturned;

        const sku = numberOf(row.item?.sku);
        if (sku === null) continue;

        const existing = bySku.get(sku) ?? {
            sku,
            name: text(row.item?.name),
            offerId: text(row.item?.offer_id),
            units: 0,
            returnedUnits: 0,
            realized: 0,
            returned: 0,
            loyalty: 0
        };

        existing.units += units;
        existing.returnedUnits += returnedUnits;
        existing.realized += realized;
        existing.returned += returnedSum;
        existing.loyalty += loyalty;
        if (!existing.name) existing.name = text(row.item?.name);

        bySku.set(sku, existing);
    }

    month.net = month.realized - month.returned;
    month.loyaltyNet = month.loyalty - month.loyaltyReturned;
    month.perSku = [...bySku.values()].sort((a, b) => b.realized - a.realized);

    return month;
}

/** Reads the balance report: what was accrued, what was paid, what is left. */
export function toBalanceSummary(raw: unknown): BalanceSummary | null {
    const root = ((raw ?? {}) as { result?: unknown }).result ?? raw;
    const total = (root as { total?: Record<string, unknown> })?.total;
    if (!total) return null;

    const pick = (source: unknown): number | null => {
        if (source === null || source === undefined) return null;
        if (typeof source === 'object') {
            return numberOf((source as { value?: unknown }).value);
        }

        return numberOf(source);
    };

    // `payments` is an array in the live response and may hold several entries.
    const payments = (total as { payments?: unknown }).payments;
    const paid = Array.isArray(payments)
        ? payments.reduce<number>((sum, entry) => sum + money(pick(entry)), 0)
        : pick(payments);

    return {
        opening: pick((total as { opening_balance?: unknown }).opening_balance),
        closing: pick((total as { closing_balance?: unknown }).closing_balance),
        accrued: pick((total as { accrued?: unknown }).accrued),
        paid
    };
}

/** Reads the weekly cash-flow statement. */
export function toWeekFlows(raw: unknown): WeekFlow[] {
    const root = ((raw ?? {}) as { result?: unknown }).result ?? raw;
    const rows = Array.isArray((root as { cash_flows?: unknown[] })?.cash_flows)
        ? ((root as { cash_flows: unknown[] }).cash_flows as unknown[])
        : [];

    return rows
        .map((entry) => {
            const row = (entry ?? {}) as Record<string, unknown>;
            const period = (row.period ?? {}) as { begin?: unknown; end?: unknown };

            const orders = money(row.orders_amount);
            const returns = money(row.returns_amount);
            const commission = money(row.commission_amount);
            const services = money(row.services_amount);
            const delivery = money(row.item_delivery_and_return_amount);

            return {
                from: text(period.begin).slice(0, 10),
                to: text(period.end).slice(0, 10),
                orders,
                returns,
                commission,
                services,
                delivery,
                net: orders + returns + commission + services + delivery
            };
        })
        .sort((a, b) => (a.from < b.from ? -1 : 1));
}

// --- Tax and cost ----------------------------------------------------------------

/**
 * What the tax is charged on.
 *
 * `realized` is the usual Russian marketplace case: a `доходы` regime taxes the revenue the
 * seller realized, not the smaller sum Ozon transfers after its own deductions. The two are
 * far apart — on one live month the realized figure was close to twice the amount received — so the
 * choice has to be named rather than assumed.
 */
export type TaxBase = 'payout' | 'realized' | 'margin';

export const TAX_BASE_LABELS: Record<TaxBase, string> = {
    payout: 'от денег, полученных от Ozon',
    realized: 'от реализованного за вычетом возвратов',
    margin: 'от прибыли (выручка минус себестоимость)'
};

export interface TaxableInput {
    /** Money received or due from Ozon. */
    payout: number;
    /**
     * Realized minus customer returns — the figure the seller declares.
     *
     * Realized alone is not the seller's price and not the whole of what buyers paid either:
     * a single report row showed 1221 ₽ set in the cabinet splitting into 642,86 paid by the
     * buyer, 571,71 funded by Ozon as discount points and 6,43 from a partner. Returns are
     * subtracted because what came back to the customer is not income.
     */
    realized: number;
    /** Cost of the goods sold, or `null` when it is not fully known. */
    cost: number | null;
}

/**
 * The amount the rate is applied to.
 *
 * Kept apart from the payout on purpose: the money Ozon sends is what remains after its
 * commission and services, while a revenue-based tax is charged on the larger realized
 * figure. Treating them as one number understates the tax by the whole of Ozon's cut.
 */
export function taxableAmount(base: TaxBase, input: TaxableInput): number {
    if (base === 'realized') return input.realized;
    if (base === 'margin') return input.cost === null ? input.realized : input.realized - input.cost;

    return input.payout;
}

export interface ProfitInput {
    /** Money received or due from Ozon for the period: the first step of the chain. */
    payout: number;
    /** What the tax is charged on, which is not necessarily the payout. */
    taxable: number;
    /** Tax rate in percent, for example 7. */
    taxPercent: number;
    /** Cost of the goods sold in the period, `null` when the cost book cannot cover them. */
    cost: number | null;
}

export interface ProfitResult {
    payout: number;
    taxable: number;
    tax: number;
    cost: number | null;
    /** What is left after the tax and the cost; `null` when the cost is unknown. */
    net: number | null;
    /** Net as a share of the money received. */
    netPercent: number | null;
}

/**
 * Payout to money actually kept: `деньги от Ozon − налог − себестоимость`.
 *
 * The tax is charged on its own base — often the realized revenue, which is larger than the
 * payout — and the cost price is deducted from what remains. A missing cost yields no net
 * figure rather than a flattering one, the same rule the margin section follows.
 *
 * This can produce a small figure or a loss, and that is not a defect: a revenue-based tax
 * is owed on the full realized amount whether or not Ozon's deductions left enough to cover
 * it.
 */
export function profitAfterTaxAndCost(input: ProfitInput): ProfitResult {
    const payout = Number.isFinite(input.payout) ? input.payout : 0;
    const taxable = Number.isFinite(input.taxable) ? input.taxable : 0;
    const cost = input.cost !== null && Number.isFinite(input.cost) ? input.cost : null;
    const taxPercent = Number.isFinite(input.taxPercent) ? Math.max(0, input.taxPercent) : 0;

    const tax = (Math.max(0, taxable) * taxPercent) / 100;

    if (cost === null) {
        return { payout, taxable, tax, cost: null, net: null, netPercent: null };
    }

    const net = payout - tax - cost;

    return {
        payout,
        taxable,
        tax,
        cost,
        net,
        netPercent: payout !== 0 ? (net / payout) * 100 : null
    };
}

// --- Period list -----------------------------------------------------------------

/**
 * `count` months ending with the one `now` falls in, newest first.
 *
 * The list is generated rather than derived from loaded orders, because the whole point is
 * to reach months the order feed does not cover.
 */
export function recentMonths(now: Date, count: number): string[] {
    const months: string[] = [];
    const cursor = new Date(now.getFullYear(), now.getMonth(), 1);

    for (let index = 0; index < Math.max(1, count); index += 1) {
        const year = cursor.getFullYear();
        const month = String(cursor.getMonth() + 1).padStart(2, '0');
        months.push(`${year}-${month}`);
        cursor.setMonth(cursor.getMonth() - 1);
    }

    return months;
}

/** The `{month, year}` pair the realization and cash-flow methods expect. */
export function monthParts(key: string): { month: number; year: number } | null {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
    if (!match) return null;

    return { year: Number(match[1]), month: Number(match[2]) };
}

/** First and last day of a month as `YYYY-MM-DD`, which the balance method requires. */
export function monthBounds(key: string): { from: string; to: string } | null {
    const parts = monthParts(key);
    if (!parts) return null;

    const lastDay = new Date(parts.year, parts.month, 0).getDate();
    const padded = String(parts.month).padStart(2, '0');

    return {
        from: `${parts.year}-${padded}-01`,
        to: `${parts.year}-${padded}-${String(lastDay).padStart(2, '0')}`
    };
}

/** One product the cost panel can price. */
export interface CostCandidate {
    key: string;
    label: string;
    units: number;
    payout: number;
}

/**
 * The products a cost panel must offer: the loaded window's, plus whatever the month adds.
 *
 * The window alone is not enough. A monthly report can contain articles that sold outside
 * the loaded order feed — read in October, the feed no longer reaches 1 September — and a
 * product the panel cannot show is a product whose cost can never be entered. The month's
 * coverage then stays below every unit, and the net figure is withheld permanently with no
 * way for the reader to satisfy it.
 *
 * `keyOf` is passed in rather than imported so this stays free of the economics layer:
 * the key rule belongs to whoever owns the cost book.
 */
export function mergeCostCandidates(
    fromWindow: CostCandidate[],
    monthLines: RealizationSku[],
    keyOf: (offerId: string, sku: number) => string
): CostCandidate[] {
    const byKey = new Map<string, CostCandidate>();

    for (const row of fromWindow) {
        byKey.set(row.key, row);
    }

    for (const line of monthLines) {
        const key = keyOf(line.offerId, line.sku);
        if (byKey.has(key)) continue;

        byKey.set(key, {
            key,
            label: line.name || line.offerId || String(line.sku),
            // Returns go back into stock, so only sold units need a cost.
            units: Math.max(0, line.units - line.returnedUnits),
            payout: line.realized
        });
    }

    return [...byKey.values()].sort((a, b) => b.units - a.units || b.payout - a.payout);
}

/** One named service charge in the balance breakdown. */
export interface ServiceFlow {
    /** Ozon's own slug, for example `logistics`. */
    name: string;
    amount: number;
}

/** Sales or returns, with the parts that make up the amount. */
export interface FlowGroup {
    /** What the seller earned or lost, fee included. */
    amount: number;
    /** The fee Ozon charges for that group. */
    fee: number;
    /** The realization report's own revenue figure. */
    revenue: number;
    /** Compensation for discounts funded by Ozon, in points. */
    points: number;
    /** Partner programmes: the bank co-investment that also appears in the report. */
    partnerPrograms: number;
}

export interface CashflowBreakdown {
    sales: FlowGroup;
    returns: FlowGroup;
    services: ServiceFlow[];
    /** Everything summed: equals the `accrued` figure, verified to the kopeck. */
    total: number;
}

/** Charges whose slugs Ozon uses in the balance breakdown. */
export const SERVICE_LABELS: Record<string, string> = {
    acquiring: 'Эквайринг',
    packing_by_agents: 'Упаковка товара партнёрами',
    product_placement_in_ozon_warehouses: 'Размещение товаров на складах Ozon',
    packing_package: 'Обеспечение материалами для упаковки',
    delivery_to_handover_place_by_ozon: 'Доставка до места выдачи силами Ozon',
    logistics: 'Логистика',
    cross_docking: 'Кросс-докинг',
    partner_returns_cancellations_processing: 'Обработка возвратов, отмен и невыкупов',
    reverse_logistics: 'Обратная логистика',
    courier_client_reinvoice: 'Доставка до места выдачи',
    pay_per_click: 'Оплата за клик'
};

/** A readable name for a service slug, falling back to the slug itself. */
export function serviceLabel(slug: string): string {
    return SERVICE_LABELS[slug] ?? slug;
}

/**
 * Reads the balance report's `cashflows` object.
 *
 * This is the most complete money picture the free tier offers: it separates the sales
 * fee — the commission that the realization report leaves at zero and the accruals bury
 * inside the net — from the named service charges, and shows the discount compensation
 * separately from real revenue. Verified against a live month: the parts add up to the
 * `accrued` total exactly, and all eleven service amounts match the accrual parsing to the
 * kopeck, which makes this a third independent reading of the same money.
 */
export function toCashflowBreakdown(raw: unknown): CashflowBreakdown | null {
    const root = ((raw ?? {}) as { result?: unknown }).result ?? raw;
    const cashflows = (root as { cashflows?: unknown })?.cashflows;
    if (!cashflows || typeof cashflows !== 'object') return null;

    const source = cashflows as {
        sales?: unknown;
        returns?: unknown;
        services?: unknown;
    };

    const readGroup = (value: unknown): FlowGroup => {
        const group = (value ?? {}) as {
            amount?: unknown;
            fee?: unknown;
            amount_details?: { revenue?: unknown; points_for_discounts?: unknown; partner_programs?: unknown };
        };
        const details = group.amount_details ?? {};

        return {
            amount: wrapped(group.amount),
            fee: wrapped(group.fee),
            revenue: wrapped(details.revenue),
            points: wrapped(details.points_for_discounts),
            partnerPrograms: wrapped(details.partner_programs)
        };
    };

    const sales = readGroup(source.sales);
    const returns = readGroup(source.returns);

    const services: ServiceFlow[] = Array.isArray(source.services)
        ? source.services
              .map((entry) => {
                  const row = (entry ?? {}) as { name?: unknown; amount?: unknown };
                  const amount = wrapped(row.amount);
                  return amount === 0 ? null : { name: text(row.name) || 'прочее', amount };
              })
              .filter((entry): entry is ServiceFlow => entry !== null)
              .sort((a, b) => a.amount - b.amount)
        : [];

    const total =
        sales.amount + sales.fee + returns.amount + returns.fee + services.reduce((sum, row) => sum + row.amount, 0);

    return { sales, returns, services, total };
}

/** Reads `{ value }` or a bare number, and the string amounts Ozon sometimes sends. */
function wrapped(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'object') return money((value as { value?: unknown }).value);

    return money(value);
}

/** Local calendar day as `YYYY-MM-DD`. */
function isoDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The settlement periods Ozon pays a month in: Monday-to-Sunday weeks, clipped to the month.
 *
 * Verified against the cabinet's own payout report for September 2026, which listed exactly
 * 01–06, 07–13, 14–20, 21–27 and 28–30. Knowing the boundaries matters because a payout is
 * the sum of the accruals dated inside one of them — checked to the kopeck on all four
 * periods that the report covered — so the same periods are what the interface must group by
 * if it is to show an amount the seller will recognise.
 */
export function payoutPeriods(monthKey: string): { from: string; to: string }[] {
    const bounds = monthBounds(monthKey);
    if (!bounds) return [];

    const periods: { from: string; to: string }[] = [];
    const last = new Date(`${bounds.to}T00:00:00`);
    let cursor = new Date(`${bounds.from}T00:00:00`);

    while (cursor <= last) {
        // Weeks end on Sunday, so a Monday-start week runs to the coming Sunday.
        const weekday = cursor.getDay();
        const toSunday = weekday === 0 ? 0 : 7 - weekday;

        const periodEnd = new Date(cursor);
        periodEnd.setDate(periodEnd.getDate() + toSunday);

        const to = periodEnd > last ? last : periodEnd;
        periods.push({ from: isoDay(cursor), to: isoDay(to) });

        cursor = new Date(to);
        cursor.setDate(cursor.getDate() + 1);
    }

    return periods;
}

export interface MonthView<T> {    /** Data belonging to the selected month, or `null` if there is none. */
    data: T | null;
    /** Failure belonging to the selected month, or `null`. */
    error: { status?: number; message?: string } | null;
    /** True when Ozon has no report for that month, which is a state and not a failure. */
    reportMissing: boolean;
}

/**
 * Decides what a month-scoped view is allowed to show.
 *
 * A month picker fetches on demand into a cache that is keyed independently of the month,
 * so at any moment the data and the error on hand may belong to a *different* month than
 * the one selected. Showing them anyway puts one month's figures — or one month's failure —
 * under another month's heading. That happened with the current month, whose report does
 * not exist yet: its 404 was displayed as an error for the month the reader had chosen.
 *
 * So both are attributed explicitly, and anything unattributable is withheld.
 */
export function monthView<T extends { month: string }>(
    selected: string,
    requested: string | null,
    data: T | null | undefined,
    error: { status?: number; message?: string } | null | undefined
): MonthView<T> {
    const usableData = data && data.month === selected ? data : null;
    const usableError = requested === selected && error ? error : null;

    return {
        data: usableData,
        error: usableError,
        reportMissing: usableError?.status === 404
    };
}
