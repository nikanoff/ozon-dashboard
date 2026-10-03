import { callOzonWithRetry, type Credentials } from './ozon';
import {
    monthBounds,
    monthParts,
    toBalanceSummary,
    toCashflowBreakdown,
    toRealizationMonth,
    toWeekFlows,
    type MonthFinance
} from '$lib/realization';

/**
 * One month of money, from three methods that answer different questions.
 *
 *   `/v2/finance/realization`          — what was realized, at the seller's price;
 *   `/v1/finance/balance`              — what was accrued, what was paid, what is left;
 *   `/v1/finance/cash-flow-statement/list` — the weekly settlement breakdown.
 *
 * The realization report is the reason this exists at all: it is a monthly document the
 * API serves for any month — December 2025 and earlier were verified to return data — while
 * the order feed only ever covers a bounded recent window. That is what lets the period
 * selector offer months the dashboard could not otherwise reach.
 */

export interface MonthFinanceResult extends MonthFinance {
    /** Set when the balance or the weekly breakdown failed; the month still renders. */
    partialError?: string;
}

export async function collectMonthFinance(
    credentials: Credentials,
    monthKey: string,
    signal?: AbortSignal
): Promise<MonthFinanceResult> {
    const parts = monthParts(monthKey);
    const bounds = monthBounds(monthKey);

    if (!parts || !bounds) {
        throw new Error(`Некорректный месяц: ${monthKey}`);
    }

    // The realization report is the core: without it there is nothing truthful to show, so
    // its failure propagates and the endpoint reports an error.
    const realization = await callOzonWithRetry<unknown>(
        '/v2/finance/realization',
        { month: parts.month, year: parts.year },
        credentials,
        signal
    );

    // The other two are enrichment: a month with realization and no balance is still useful,
    // so their failures are collected into one message instead of failing the request.
    const [balanceResult, flowResult] = await Promise.allSettled([
        callOzonWithRetry<unknown>(
            '/v1/finance/balance',
            { date_from: bounds.from, date_to: bounds.to },
            credentials,
            signal
        ),
        callOzonWithRetry<unknown>(
            '/v1/finance/cash-flow-statement/list',
            {
                date: {
                    from: `${bounds.from}T00:00:00.000Z`,
                    to: `${bounds.to}T23:59:59.000Z`
                },
                page: 1,
                page_size: 50
            },
            credentials,
            signal
        )
    ]);

    const failures: string[] = [];
    if (balanceResult.status === 'rejected') failures.push('баланс');
    if (flowResult.status === 'rejected') failures.push('движение средств');

    return {
        month: monthKey,
        realization: toRealizationMonth(realization),
        balance: balanceResult.status === 'fulfilled' ? toBalanceSummary(balanceResult.value) : null,
        cashflows:
            balanceResult.status === 'fulfilled' ? toCashflowBreakdown(balanceResult.value) : null,
        weeks: flowResult.status === 'fulfilled' ? toWeekFlows(flowResult.value) : [],
        fetchedAt: new Date().toISOString(),
        ...(failures.length > 0
            ? { partialError: `Не удалось загрузить: ${failures.join(', ')}` }
            : {})
    };
}
