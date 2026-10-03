import type { CapitalSummary } from './capital';
import type { SkuEconomics } from './economics';
import type { FinanceSummary } from './pnl';

/**
 * What needs doing, with the money at stake attached.
 *
 * A dashboard that only reports is a report. This turns everything computed elsewhere —
 * stock cover, margins, frozen capital, the freshness of the financial layer — into a
 * short ranked list of decisions, each with the amount it is worth.
 *
 * Two habits are deliberate:
 *
 *   - every action states its **basis**: a day, a period, or a one-off amount. Mixing
 *     "forgoes 2 000 ₽ a day" with "lost 6 000 ₽ last month" into one ranked column
 *     would compare things that are not comparable;
 *   - an action is only raised when the underlying figure is actually known, so a missing
 *     cost price produces "set costs" rather than a fabricated loss.
 */

export type ActionSeverity = 'high' | 'medium' | 'low';

export type ActionKind =
    | 'stockout'
    | 'lowCover'
    | 'lossMaking'
    | 'frozenCapital'
    | 'missingCosts'
    | 'staleFinance'
    | 'failedFinance';

export interface StoreAction {
    kind: ActionKind;
    severity: ActionSeverity;
    title: string;
    detail: string;
    /** Money at stake, or `null` when the problem cannot be priced yet. */
    amount: number | null;
    basis: 'day' | 'period' | 'once' | 'none';
    /** Products the action points at, worst first. */
    skus: { key: string; name: string }[];
}

export interface ActionInput {
    capital: CapitalSummary;
    economics: SkuEconomics[];
    finance: FinanceSummary;
    /** Share of stock units whose cost is known, 0..1. */
    costedShare: number;
    /** Cost coverage over sold units, 0..1. */
    soldCostCoverage: number;
    now: Date;
    /** Days without fresh accruals before the financial layer is called stale. */
    staleAfterDays?: number;
}

/** How many days of silence from the accrual feed count as a broken integration. */
export const STALE_AFTER_DAYS = 3;

/** Whole days between two `YYYY-MM-DD` days, or `null` if either is unparseable. */
export function daysApart(from: string, to: Date): number | null {
    const [year, month, day] = from.split('-').map(Number);
    if (!year || !month || !day) return null;

    const start = Date.UTC(year, month - 1, day);
    const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());

    return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

const SEVERITY_ORDER: Record<ActionSeverity, number> = { high: 0, medium: 1, low: 2 };

export function buildActions(input: ActionInput): StoreAction[] {
    const {
        capital,
        economics,
        finance,
        costedShare,
        soldCostCoverage,
        now,
        staleAfterDays = STALE_AFTER_DAYS
    } = input;

    const actions: StoreAction[] = [];

    // Out of stock while still selling: the most expensive state a shop can be in,
    // because every day it lasts is a day of demand that goes to a competitor.
    if (capital.lostRows.length > 0) {
        const priced = capital.lostProfitPerDay ?? capital.lostRevenuePerDay;
        actions.push({
            kind: 'stockout',
            severity: 'high',
            title: `Закончилось: ${capital.lostRows.length} SKU со спросом`,
            detail:
                capital.lostProfitPerDay === null
                    ? 'Товар продаётся, но его нет на складе. Указана упущенная выручка в день; маржа станет известна после ввода себестоимости.'
                    : 'Товар продаётся, но его нет на складе. Каждый день простоя — упущенная маржа.',
            amount: priced > 0 ? priced : null,
            basis: 'day',
            skus: capital.lostRows.slice(0, 5).map((row) => ({ key: row.key, name: row.name }))
        });
    }

    // Under a week of cover on items that still have demand.
    const critical = capital.rows.filter((row) => row.health === 'critical');
    if (critical.length > 0) {
        const revenuePerDay = critical.reduce(
            (sum, row) => sum + row.demandPerDay * row.unitPrice,
            0
        );
        actions.push({
            kind: 'lowCover',
            severity: critical.length > 3 ? 'high' : 'medium',
            title: `Заканчивается за неделю: ${critical.length} SKU`,
            detail: 'Запаса хватит меньше чем на 7 дней при текущем темпе продаж.',
            amount: revenuePerDay > 0 ? revenuePerDay : null,
            basis: 'day',
            skus: critical.slice(0, 5).map((row) => ({ key: row.key, name: row.name }))
        });
    }

    const losers = economics.filter((row) => row.grossProfit !== null && row.grossProfit < 0);
    if (losers.length > 0) {
        const loss = losers.reduce((sum, row) => sum + (row.grossProfit ?? 0), 0);
        actions.push({
            kind: 'lossMaking',
            severity: 'high',
            title: `Продаются ниже себестоимости: ${losers.length} SKU`,
            detail:
                'Каждая продажа уменьшает деньги на счёте. Стоит поднять цену до безубыточной или вывести товар.',
            amount: Math.abs(loss),
            basis: 'period',
            skus: losers.slice(0, 5).map((row) => ({ key: row.key, name: row.name }))
        });
    }

    if (capital.frozenAtCost !== null && capital.frozenAtCost > 0) {
        actions.push({
            kind: 'frozenCapital',
            severity: 'medium',
            title: `Заморожено в неликвиде: ${capital.frozenSkus} SKU`,
            detail:
                'Эти деньги уже заплачены поставщику и не возвращаются продажами. Плюс за них начисляется хранение.',
            amount: capital.frozenAtCost,
            basis: 'once',
            skus: []
        });
    }

    // The financial layer is the only source of what actually reaches the account, so
    // its silence has to be loud. This is the check whose absence let a seller compute
    // profit for two weeks from data that had stopped arriving.
    if (finance.failedDays.length > 0) {
        actions.push({
            kind: 'failedFinance',
            severity: 'high',
            title: `Начисления не загрузились: ${finance.failedDays.length} дн.`,
            detail:
                finance.failedDays[0]?.error ??
                'Дни не получены, и в суммы они не подставлены нулём.',
            amount: null,
            basis: 'none',
            skus: []
        });
    } else if (finance.lastDayWithData) {
        const gap = daysApart(finance.lastDayWithData, now);
        if (gap !== null && gap > staleAfterDays) {
            actions.push({
                kind: 'staleFinance',
                severity: 'high',
                title: `Начисления отстают на ${gap} дн.`,
                detail: `Последние начисления — за ${finance.lastDayWithData}. Обычно Ozon пишет их ежедневно, поэтому это похоже на сломанную интеграцию, а не на паузу в продажах.`,
                amount: null,
                basis: 'none',
                skus: []
            });
        }
    }

    if (soldCostCoverage < 1 && economics.length > 0) {
        actions.push({
            kind: 'missingCosts',
            severity: costedShare === 0 ? 'medium' : 'low',
            title: 'Не по всем товарам задана себестоимость',
            detail:
                'Пока её нет, маржа, ABC по прибыли и убыточные товары посчитать нельзя — и мы не подставляем ноль.',
            amount: null,
            basis: 'none',
            skus: []
        });
    }

    return actions.sort((a, b) => {
        const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (bySeverity !== 0) return bySeverity;

        // Within a severity, the biggest amount first; unpriced items last.
        return (b.amount ?? -1) - (a.amount ?? -1);
    });
}
