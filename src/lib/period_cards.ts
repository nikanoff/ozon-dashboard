import type { AccrualDaySummary } from './accruals';
import { costKey, type CostLookup } from './economics';
import { dayKey, daysOfMonth, isValidMonthKey, monthKey, monthLabel, previousMonthKey } from './period';
import {
    profitAfterTaxAndCost,
    taxableAmount,
    type RealizationSku,
    type TaxBase
} from './realization';
import { postingTotal, postingUnits, isCrossCluster } from './stats';
import type { DashboardPosting, OzonReturn } from './ozon_types';

/**
 * The four "right now" cards at the top of the dashboard.
 *
 * They answer a different question from the rest of the page. Everything below reads one
 * selected calendar month, because that is the unit Ozon's documents come in; these cards
 * are anchored to today instead — today, yesterday, the month so far, and the month that
 * closed — so the seller can see the shop breathing without changing a selector.
 *
 * Three rules carried over from the money sections, because each of them was learned from a
 * figure that lied:
 *
 *   1. **A gap is not a zero.** Accruals arrive a day late and month by month, so a window
 *      the feed does not cover yields `null`, never a sum of what happened to be loaded.
 *      A profit built on partial costs is withheld the same way.
 *   2. **Money comes from accruals, not from order cards.** The payout on an order card is
 *      price minus commission and excludes logistics, handling and acquiring, so a profit
 *      built on it reads high by the whole of those charges.
 *   3. **Advertising is a cost already inside that money.** Ozon deducts it as a cabinet
 *      accrual, verified to the kopeck against the advertising cabinet, so it is reported
 *      beside the payout and never subtracted from it a second time.
 */

export type CardKey = 'today' | 'yesterday' | 'monthToDate' | 'lastMonth';

/** A window a card reports on, plus the window it is compared against. */
export interface CardWindow {
    key: CardKey;
    label: string;
    /** Human wording of the window: «4 октября», «1–4 октября», «сентябрь 2026». */
    range: string;
    /** Inclusive `YYYY-MM-DD` edges. */
    from: string;
    to: string;
    /**
     * The window this one is measured against.
     *
     * `short` is for the percentage on the card: the badge says what it compares to («+62,9 %
     * к 2 окт.»), because a change with no stated base is a number the reader has to guess at.
     */
    compare: { from: string; to: string; range: string; short: string } | null;
    /**
     * True when the window contains today.
     *
     * Such a window is still being written to: its orders keep arriving and Ozon has not
     * accrued anything for it yet, so the money rows read as "not yet" rather than as a
     * collapse, and a percentage against a finished window would compare a part to a whole.
     */
    open: boolean;
    /** The calendar month, when the window is exactly one. */
    month: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(day: string, delta: number): string {
    const date = new Date(`${day}T00:00:00`);
    return dayKey(new Date(date.getTime() + delta * DAY_MS));
}

/** «4 октября» — a day as the seller reads it. */
export function dayLabel(day: string): string {
    const [year, month, date] = day.split('-').map(Number);
    if (!year || !month || !date) return day;

    return new Date(year, month - 1, date).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long'
    });
}

/**
 * «2 окт.» — the same day, short enough to sit beside a percentage.
 *
 * A badge reads «+62,9 % к 2 окт.», and at that length the reader learns what the change is
 * against without opening anything. The long form belongs in the breakdown, not next to the
 * figure it qualifies.
 */
export function shortDayLabel(day: string): string {
    const [year, month, date] = day.split('-').map(Number);
    if (!year || !month || !date) return day;

    return new Date(year, month - 1, date)
        .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
        .replace(/\s*г\.$/, '')
        .trim();
}

/** «авг. 2026» — a month, short enough for the same line. */
export function shortMonthLabel(key: string): string {
    if (!isValidMonthKey(key)) return key;

    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1)
        .toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' })
        .replace(/\s*г\.$/, '')
        .trim();
}

/** «1–4 сент.», or both months when the window crosses one. */
export function shortRangeLabel(from: string, to: string): string {
    if (from === to) return shortDayLabel(from);
    if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${shortDayLabel(to)}`;

    return `${shortDayLabel(from)} — ${shortDayLabel(to)}`;
}

/** «1–4 октября», or both months spelled out when a window crosses one. */
export function dayRangeLabel(from: string, to: string): string {
    if (from === to) return dayLabel(from);
    if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${dayLabel(to)}`;

    return `${dayLabel(from)} — ${dayLabel(to)}`;
}

/** Every calendar day of a window, oldest first. */
export function daysBetween(from: string, to: string): string[] {
    const days: string[] = [];
    if (from > to) return days;

    for (let day = from; day <= to; day = addDays(day, 1)) {
        days.push(day);
        // A malformed pair must not loop forever.
        if (days.length > 400) break;
    }

    return days;
}

/**
 * The four windows, as of `now`.
 *
 * The comparison windows are the same shape as the window itself: a day against a day, the
 * month so far against the same days of the previous month (clipped when that month is
 * shorter), and a closed month against the month before it.
 */
export function cardWindows(now = new Date()): CardWindow[] {
    const currentMonth = monthKey(now);
    const previousMonth = previousMonthKey(currentMonth);
    const monthBefore = previousMonthKey(previousMonth);

    const today = dayKey(now);
    const yesterday = addDays(today, -1);
    const beforeYesterday = addDays(today, -2);

    const monthStart = `${currentMonth}-01`;
    const dayOfMonth = Number(today.slice(8));

    const previousDays = daysOfMonth(previousMonth);
    const previousEnd = previousDays[previousDays.length - 1] ?? `${previousMonth}-01`;
    // The month so far is compared against the same number of days, so a short previous
    // month clips the comparison instead of reaching into the month before it.
    const comparableEnd = previousDays[Math.min(dayOfMonth, previousDays.length) - 1] ?? previousEnd;

    const monthBeforeDays = daysOfMonth(monthBefore);
    const monthBeforeEnd = monthBeforeDays[monthBeforeDays.length - 1] ?? `${monthBefore}-01`;

    return [
        {
            key: 'today',
            label: 'Сегодня',
            range: dayLabel(today),
            from: today,
            to: today,
            compare: {
                from: yesterday,
                to: yesterday,
                range: dayLabel(yesterday),
                short: shortDayLabel(yesterday)
            },
            open: true,
            month: null
        },
        {
            key: 'yesterday',
            label: 'Вчера',
            range: dayLabel(yesterday),
            from: yesterday,
            to: yesterday,
            compare: {
                from: beforeYesterday,
                to: beforeYesterday,
                range: dayLabel(beforeYesterday),
                short: shortDayLabel(beforeYesterday)
            },
            open: false,
            month: null
        },
        {
            key: 'monthToDate',
            label: 'С начала месяца',
            range: dayRangeLabel(monthStart, today),
            from: monthStart,
            to: today,
            compare: {
                from: `${previousMonth}-01`,
                to: comparableEnd,
                range: dayRangeLabel(`${previousMonth}-01`, comparableEnd),
                short: shortRangeLabel(`${previousMonth}-01`, comparableEnd)
            },
            open: true,
            month: currentMonth
        },
        {
            key: 'lastMonth',
            label: 'Прошлый месяц',
            range: monthLabel(previousMonth),
            from: `${previousMonth}-01`,
            to: previousEnd,
            compare: {
                from: `${monthBefore}-01`,
                to: monthBeforeEnd,
                range: monthLabel(monthBefore),
                short: shortMonthLabel(monthBefore)
            },
            open: false,
            month: previousMonth
        }
    ];
}

/**
 * Every day of accruals the four cards read: the previous calendar month and the current one.
 *
 * Two months at most, which is what the accrual endpoint accepts in one request. The caller
 * unions this with the days its monthly sections need and asks for whatever is missing.
 */
export function cardAccrualDays(now = new Date()): string[] {
    const current = monthKey(now);
    const previous = previousMonthKey(current);
    const today = dayKey(now);

    return [...daysOfMonth(previous), ...daysOfMonth(current).filter((day) => day <= today)];
}

/** The window returns are collected for: the previous calendar month through today. */
export function cardReturnsWindow(now = new Date()): { from: string; to: string } {
    return { from: `${previousMonthKey(monthKey(now))}-01`, to: dayKey(now) };
}

export interface OrdersTotals {
    /** Seller price of the orders that were not cancelled — the money buyers paid. */
    sales: number;
    orders: number;
    units: number;
    cancelled: number;
    cancelledSum: number;
    cancelledUnits: number;
    /** Orders shipped between two different Ozon clusters: logistics cost more. */
    crossCluster: number;
}

/** Orders created inside a window, split into what sold and what was cancelled. */
export function ordersTotals(
    postings: DashboardPosting[],
    from: string,
    to: string
): OrdersTotals {
    const totals: OrdersTotals = {
        sales: 0,
        orders: 0,
        units: 0,
        cancelled: 0,
        cancelledSum: 0,
        cancelledUnits: 0,
        crossCluster: 0
    };

    for (const posting of postings) {
        const createdAt = new Date(posting.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;

        const day = dayKey(createdAt);
        if (day < from || day > to) continue;

        const total = postingTotal(posting);
        const units = postingUnits(posting);

        if (posting.status === 'cancelled') {
            totals.cancelled += 1;
            totals.cancelledSum += total;
            totals.cancelledUnits += units;
            continue;
        }

        totals.sales += total;
        totals.orders += 1;
        totals.units += units;
        if (isCrossCluster(posting)) totals.crossCluster += 1;
    }

    return totals;
}

/**
 * Fee types Ozon charges for advertising, by `type_id`.
 *
 * `41` is the one this account actually pays — pay per click, matched to the advertising
 * cabinet to the kopeck. The rest are the neighbouring mechanics of the same kind: brand
 * promotion, ad services, on-site and social advertising, media placement. They are listed
 * together so a campaign that moves from one mechanic to another does not fall out of the
 * line silently; an unknown future type still shows up in the payout, where it belongs.
 */
export const ADVERTISING_TYPE_IDS = ['41', '54', '33', '23', '87', '130'] as const;

export interface AccrualTotals {
    /** What Ozon accrued over the window; advertising is already deducted inside it. */
    net: number;
    /** Advertising charges inside that net, as a positive cost. */
    advertising: number;
    /** The same figure split the way the money arrives: orders, and the cabinet's own costs. */
    orders: number;
    cabinet: number;
    /**
     * Advertising by fee type, so a tooltip can name what was charged instead of only
     * totalling it. Keyed by `type_id`; the catalogue turns those into words.
     */
    advertisingByType: Record<string, number>;
    /**
     * The net by accrual category: `POSTING` for what was charged on a shipment, `ITEM` for
     * charges that live on the product (acquiring), `NON_ITEM` for the cabinet's own documents.
     */
    byCategory: Record<string, number>;
    /** Days expected, present, missing and failed. */
    expected: number;
    loaded: number;
    missing: string[];
    failed: string[];
    /** True when every expected day arrived and none of them failed. */
    complete: boolean;
}

/**
 * Accruals over a window, with the gaps named.
 *
 * `missing` and `failed` are kept apart because they call for different reactions: a day
 * never fetched is a request to make, a day that failed is a method to retry. Neither may be
 * folded into the sum, which is why `complete` gates every money figure downstream.
 *
 * The orders/cabinet split is the same one `summariseFinance` makes for the monthly view: a
 * `NON_ITEM` accrual is the cabinet's own cost (storage, advertising, cross-docking), and
 * everything else belongs to an order. Keeping the split here lets a card say what the payout
 * is made of without a second pass over the days.
 */
export function accrualTotals(
    days: Record<string, AccrualDaySummary>,
    expected: string[]
): AccrualTotals {
    let net = 0;
    let advertising = 0;
    let cabinet = 0;
    let loaded = 0;
    const advertisingByType: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const missing: string[] = [];
    const failed: string[] = [];

    for (const day of expected) {
        const summary = days[day];
        if (!summary) {
            missing.push(day);
            continue;
        }
        if (summary.status === 'failed') {
            failed.push(day);
            continue;
        }

        loaded += 1;
        net += summary.net;
        cabinet += summary.cabinetByType.total ?? 0;

        for (const [category, amount] of Object.entries(summary.byCategory)) {
            if (typeof amount === 'number' && Number.isFinite(amount)) {
                byCategory[category] = (byCategory[category] ?? 0) + amount;
            }
        }

        for (const typeId of ADVERTISING_TYPE_IDS) {
            const amount = summary.byType[typeId];
            if (typeof amount === 'number' && Number.isFinite(amount)) {
                advertising += amount;
                advertisingByType[typeId] = (advertisingByType[typeId] ?? 0) + amount;
            }
        }
    }

    return {
        net,
        // Charges arrive negative; the card shows a cost, so the sign is dropped here once.
        advertising: Math.abs(advertising),
        // `net` already contains the cabinet's share, so taking it out leaves the orders.
        orders: net - cabinet,
        cabinet,
        // Drop types that netted to zero, and keep the magnitudes the card displays.
        advertisingByType: Object.fromEntries(
            Object.entries(advertisingByType)
                .filter(([, amount]) => amount !== 0)
                .map(([typeId, amount]) => [typeId, Math.abs(amount)])
        ),
        byCategory,
        expected: expected.length,
        loaded,
        missing,
        failed,
        complete: missing.length === 0 && failed.length === 0
    };
}

/** One kind of return: how many, how many units, and what they sold for. */
export interface ReturnsBucket {
    count: number;
    units: number;
    amount: number;
}

export interface ReturnsTotals {
    count: number;
    units: number;
    /** Sale price of the returned units, at the price they sold for. */
    amount: number;
    /** Ozon's `Cancellation`: the buyer never collected the order. */
    notPickedUp: ReturnsBucket;
    /** Ozon's `ClientReturn`: a collected order came back. */
    clientReturn: ReturnsBucket;
    /** Types Ozon may add later, counted apart so nothing is hidden inside a total. */
    other: ReturnsBucket;
}

const emptyBucket = (): ReturnsBucket => ({ count: 0, units: 0, amount: 0 });

/** Returns registered inside a window. */
export function returnsTotals(
    returns: OzonReturn[],
    from: string,
    to: string
): ReturnsTotals {
    const totals: ReturnsTotals = {
        count: 0,
        units: 0,
        amount: 0,
        notPickedUp: emptyBucket(),
        clientReturn: emptyBucket(),
        other: emptyBucket()
    };

    for (const row of returns) {
        if (row.date < from || row.date > to) continue;

        totals.count += 1;
        totals.units += row.units;
        totals.amount += row.amount;

        const bucket =
            row.type === 'Cancellation'
                ? totals.notPickedUp
                : row.type === 'ClientReturn'
                  ? totals.clientReturn
                  : totals.other;

        bucket.count += 1;
        bucket.units += row.units;
        bucket.amount += row.amount;
    }

    return totals;
}

export interface CogsTotals {
    /** Cost of the units that stayed sold, returns deducted. */
    cogs: number;
    /** Units that stayed sold. */
    units: number;
    /** Units whose cost is known. */
    coveredUnits: number;
    /** True when every remaining unit has a known cost. */
    complete: boolean;
}

/**
 * Cost of goods for a window: what sold, minus what came back.
 *
 * Returns are netted per article rather than subtracted in money, because a return is a unit
 * that goes back into stock and not a price: the unit's cost returns with it. When returns
 * exceed sales inside one window — a quiet day with a backlog — the extra units are ignored,
 * since their cost was booked against the sale they belong to in an earlier window.
 *
 * Costs resolve against the order's own date, so a margin for August uses August's purchase
 * price rather than today's.
 */
export function costOfGoods(
    postings: DashboardPosting[],
    returns: OzonReturn[],
    from: string,
    to: string,
    costs: CostLookup
): CogsTotals {
    interface Line {
        offerId: string;
        sku: number;
        units: number;
        at: Date;
    }

    const sold = new Map<string, Line>();

    for (const posting of postings) {
        if (posting.status === 'cancelled') continue;

        const createdAt = new Date(posting.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;
        const day = dayKey(createdAt);
        if (day < from || day > to) continue;

        for (const product of posting.products ?? []) {
            const units = product.quantity || 1;
            if (units <= 0) continue;

            const key = costKey(product.offer_id, product.sku);
            const line = sold.get(key) ?? {
                offerId: product.offer_id,
                sku: product.sku,
                units: 0,
                at: createdAt
            };
            line.units += units;
            sold.set(key, line);
        }
    }

    const returned = new Map<string, number>();
    for (const row of returns) {
        if (row.date < from || row.date > to) continue;
        const key = costKey(row.offerId, row.sku);
        returned.set(key, (returned.get(key) ?? 0) + row.units);
    }

    let cogs = 0;
    let units = 0;
    let coveredUnits = 0;

    for (const [key, line] of sold) {
        const net = Math.max(0, line.units - (returned.get(key) ?? 0));
        if (net === 0) continue;

        units += net;
        const unitCost = costs(line.offerId, line.sku, line.at);
        if (unitCost === undefined) continue;

        cogs += net * unitCost;
        coveredUnits += net;
    }

    return { cogs, units, coveredUnits, complete: units === 0 || coveredUnits === units };
}

/**
 * Cost of the goods a monthly realization report says were sold.
 *
 * Shared with the month sections on purpose: the cards and the monthly chain must agree on
 * what "cost of goods" means, or the same month would show two different profits. Units are
 * net of the report's own returns, and each is valued at the cost that applied on the given
 * date — the month's last day for a closed month.
 */
export function realizationCost(
    lines: RealizationSku[],
    at: Date,
    costs: CostLookup
): CogsTotals {
    let cogs = 0;
    let units = 0;
    let coveredUnits = 0;

    for (const line of lines) {
        const sold = Math.max(0, line.units - line.returnedUnits);
        if (sold === 0) continue;

        units += sold;
        const unitCost = costs(line.offerId, line.sku, at);
        if (unitCost === undefined) continue;

        cogs += sold * unitCost;
        coveredUnits += sold;
    }

    return { cogs, units, coveredUnits, complete: units === 0 || coveredUnits === units };
}

export interface CardProfit {
    /** Accrued money for the window, or `null` when the accruals do not cover it. */
    payout: number | null;
    /** What the tax is charged on, or `null` when that source does not exist for the window. */
    taxable: number | null;
    /** `null` when the base is unknown, which is not the same as a tax of zero. */
    tax: number | null;
    cogs: number | null;
    grossProfit: number | null;
    netProfit: number | null;
    /** False when the cost book cannot cover the units sold. */
    costKnown: boolean;
    /** Share of sold units whose cost is known, 0..1. */
    costCoverage: number;
}

/**
 * The money chain of one card: payout, minus cost of goods, minus tax.
 *
 * The rate and the base are the seller's own settings, read from the same store the month
 * sections use, and the chain itself is `profitAfterTaxAndCost` — so a card and a month
 * cannot drift apart in how they charge tax.
 *
 * `realized` is what the base may need, and it is **not** the card's Sales. Ozon's realized
 * revenue is what buyers actually paid, which is smaller than the seller's price by the
 * discount Ozon funds itself: in September 2026 the order feed summed 492 334 ₽ against
 * 251 359,02 ₽ of realized revenue, so charging a revenue-based tax on the order feed
 * overstated it by 16 868 ₽ — 1,96 times. It comes from the monthly realization report, which
 * exists only for a closed month; a day of the running month therefore has no revenue base,
 * and gets a dash rather than a number that would be nearly twice too large.
 *
 * Advertising is not subtracted here: it is already inside the payout, because Ozon charges
 * it as an accrual. Subtracting the card's own advertising line again would count it twice.
 */
export function cardProfit(input: {
    accrual: AccrualTotals;
    /** Realized revenue minus returns from the month's report, or `null` without one. */
    realized: number | null;
    cost: CogsTotals;
    taxPercent: number;
    base: TaxBase;
}): CardProfit {
    const payout = input.accrual.complete ? input.accrual.net : null;
    const costKnown = input.cost.complete;
    const cogs = costKnown ? input.cost.cogs : null;

    // Whether the base has a source at all. A money-based regime needs only the payout; the
    // two revenue-based ones need the monthly report, and `margin` also needs a known cost.
    const baseKnown =
        input.base === 'payout'
            ? payout !== null
            : input.base === 'realized'
              ? input.realized !== null
              : input.realized !== null && cogs !== null;

    const taxable = baseKnown
        ? taxableAmount(input.base, {
              payout: payout ?? 0,
              realized: input.realized ?? 0,
              cost: cogs
          })
        : null;

    const money = profitAfterTaxAndCost({
        payout: payout ?? 0,
        taxable: taxable ?? 0,
        taxPercent: input.taxPercent,
        cost: cogs
    });

    return {
        payout,
        taxable,
        // The tax of an unknown base is unknown: zero would read as "nothing is owed".
        tax: taxable === null ? null : money.tax,
        cogs,
        grossProfit: payout !== null && cogs !== null ? payout - cogs : null,
        // A net needs both sides of the chain: without the payout feed or a known cost there is
        // no profit to state, even though the tax on the base is still owed and shown.
        netProfit: taxable === null || payout === null || cogs === null ? null : money.net,
        costKnown,
        costCoverage: input.cost.units > 0 ? input.cost.coveredUnits / input.cost.units : 0
    };
}

/** Percentage change, or `null` when there is no base to compare against. */
export function deltaPercent(current: number, previous: number): number | null {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;

    return ((current - previous) / previous) * 100;
}
