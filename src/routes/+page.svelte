<script lang="ts">
    import { getDashboardData, getStocksData, getEconomicsData, getMonthFinance, getMonthRealization } from "$lib/ozon_api";
    import {
        cachedWindow,
        daysToFetch,
        emptyAccrualCache,
        mergeAccrualDays,
        pruneAccrualCache,
        type AccrualCache,
    } from "$lib/accrual_cache";
    import {
        dayKey,
        daysOfMonth,
        isInsidePeriod,
        lastCompleteMonth,
        monthKey,
        monthLabel,
        previousMonthKey,
    } from "$lib/period";
    import {
        accrualTotals,
        cardAccrualDays,
        cardProfit,
        cardReturnsWindow,
        cardWindows,
        costOfGoods,
        daysBetween,
        deltaPercent,
        ordersTotals,
        realizationCost,
        returnsTotals,
        type AccrualTotals,
        type CardProfit,
        type CogsTotals,
        type OrdersTotals,
        type ReturnsTotals,
    } from "$lib/period_cards";
    import { MAX_ACCRUAL_DAYS } from "$lib/accruals";
    import {
        mergeCostCandidates,
        monthBounds,
        monthView,
        payoutPeriods,
        profitAfterTaxAndCost,
        recentMonths,
        serviceLabel,
        taxableAmount,
    } from "$lib/realization";
    import { taxSettings, TAX_BASE_LABELS } from "$lib/stores/tax";
    import type { TaxBase } from "$lib/realization";
    import PeriodPicker from "$lib/components/PeriodPicker.svelte";
    import { summariseFinance, moneyInTransit } from "$lib/pnl";
    import {
        mergeDashboardPayload,
        needsFullLoad,
        refreshSince,
        coversWindow,
    } from "$lib/dashboard_cache";
    import type { DashboardPayload } from "$lib/ozon_types";
    import { peekCache, useSWR } from "$lib/swr";
    import { refreshOnKeysChange } from "$lib/refresh_on_keys";
    import { calculateStats, productUnitPrice } from "$lib/stats";
    import {
        actionBreakdown,
        byCity,
        byPaymentType,
        clusterRoutes,
        dailyTrend,
        hourlyActivity,
        promoShare,
        revenueConcentration,
        topProducts,
    } from "$lib/metrics";
    import { inventoryInsights } from "$lib/inventory";
    import {
        enrichLines,
        costBookLookup,
        costKey,
        skuEconomics,
    } from "$lib/economics";
    import { capitalSummary } from "$lib/capital";
    import { costBook } from "$lib/stores/cogs";
    import CogsPanel from "$lib/components/CogsPanel.svelte";
    import {
        formatCurrency,
        formatCurrencyParts,
        formatCurrencyPrecise,
        formatDay,
        formatDelta,
        formatNumber,
        formatPercent,
    } from "$lib/format";
    import { ozonKeys } from "$lib/stores/ozon_keys";
    import OzonHeader from "$lib/components/OzonHeader.svelte";
    import InfoTip from "$lib/components/InfoTip.svelte";
    import MetricTip from "$lib/components/MetricTip.svelte";
    import { get } from "svelte/store";
    import { onDestroy } from "svelte";
    import { describeFailure } from "$lib/failures";

    const clientId = get(ozonKeys).clientId;
    const cacheKey = `ozon-dashboard:${clientId}`;

    /**
     * The month every money section reports on.
     *
     * Declared above the requests rather than with the rest of the period state, because
     * `useSWR` runs its first request the moment it is created: anything that request reads
     * has to be initialised already, and reading this one earlier threw a temporal-dead-zone
     * error the reader saw as raw text.
     *
     * The last closed month, not the current one: the current month is a few days old, has
     * no realization report, and makes every section look as though its data had vanished.
     */
    let periodMonth = $state(lastCompleteMonth(new Date()));

    /**
     * Which month the last request was actually for.
     *
     * The SWR key is stable — it has to be, because the hook does not re-run when a key
     * changes — so without this a failure for one month would be displayed under the label
     * of another. That is exactly what happened with October's missing report appearing as
     * a September error. It starts as `null`: before any request there is nothing to
     * attribute, and an unattributed error stays hidden.
     *
     * Declared here for the same reason as the month above: the request assigns to it, and
     * the request starts the moment its hook is created.
     */
    let requestedMonth = $state<string | null>(null);

    /**
     * The earliest order the page needs: the first day of the month on screen.
     *
     * Read inside the request closure rather than passed in, because the SWR key is fixed for
     * the lifetime of the component — a month change forces a revalidation instead of a new
     * key.
     */
    const dashboardWindowFrom = $derived.by(() => {
        const firstOfMonth = `${periodMonth}-01`;
        // The bento's widest window is 31 days back, anchored to today rather than the month.
        const thirtyOneDaysAgo = dayKey(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));

        return firstOfMonth < thirtyOneDaysAgo ? firstOfMonth : thirtyOneDaysAgo;
    });

    /**
     * The last day of the month on screen, or `undefined` for a month still running.
     *
     * Stating both ends is what lets an old month be fetched as one bounded range: the walk
     * costs the month's own length rather than its distance from today. The endpoint pairs it
     * with today's tail, so the bento keeps working while a year-old month is on screen.
     */
    const dashboardWindowTo = $derived.by(() => {
        // `null` for an unusable key, which leaves the endpoint to default to today.
        const monthEnd = monthBounds(periodMonth)?.to;
        const tomorrow = dayKey(new Date(Date.now() + 24 * 60 * 60 * 1000));

        return monthEnd !== undefined && monthEnd < tomorrow ? monthEnd : undefined;
    });

    /**
     * The period cards' own month: the calendar month before today.
     *
     * The cards are anchored to today — today, yesterday, the month so far, and the month that
     * closed — so three of their windows sit inside the recent tail the endpoint always walks.
     * The fourth is the previous calendar month, and it falls outside both other ranges the
     * moment an older month is selected: a 31-day tail starting on 3 September holds two days
     * of it less than it needs. Stating the month explicitly is what closes that gap, and it
     * is also where the returns feed starts.
     */
    const cardWindow = $derived.by(() => {
        const month = previousMonthKey(monthKey(new Date()));
        const days = daysOfMonth(month);

        return { from: `${month}-01`, to: days[days.length - 1] ?? `${month}-01` };
    });

    /** That month as `YYYY-MM`, which is how the realization report is asked for. */
    const cardMonth = $derived(cardWindow.from.slice(0, 7));

    const swrResult = useSWR(
        // Account-scoped key. The key itself is fixed for the lifetime of this
        // component, so `refreshOnKeysChange` below resets both requests: that is
        // what stops the previous account's payload from surviving a key change.
        cacheKey,
        async (signal) => {
            if (!$ozonKeys.clientId || !$ozonKeys.apiKey) {
                throw new Error(
                    "Укажите Client ID и API Key в настройках (шестерёнка справа сверху).",
                );
            }

            const previous = peekCache<DashboardPayload>(cacheKey);

            // The window has to cover the month on screen, or its first days would be missing
            // from every order-derived figure. The bento's 31-day windows are anchored to
            // today, so the window is whichever starts earlier: the selected month or 31 days
            // back.
            const windowFrom = dashboardWindowFrom;
            const windowTo = dashboardWindowTo;

            // Asked of the ranges the payload was fetched with, never of its earliest edge:
            // see `coversWindow` for the day of September that mistake cost.
            const neededTo = windowTo ?? dayKey(new Date());
            const covered = coversWindow(previous, windowFrom, neededTo);

            if (previous && covered && !needsFullLoad(previous)) {
                // Only the recent tail of the history can still change, so a refresh asks for
                // that window and folds it into what is already on screen.
                return mergeDashboardPayload(
                    previous,
                    await getDashboardData(signal, refreshSince(), windowFrom, windowTo, cardWindow),
                );
            }

            // The endpoint walks Ozon's cursors server-side and returns only the
            // fields the table renders, so the browser makes a single request.
            return getDashboardData(signal, windowFrom, windowFrom, windowTo, cardWindow);
        },
        // The 31-day figures change slowly, so a minute was far too eager.
        { dedupingInterval: 2000, refreshInterval: 5 * 60 * 1000 },
    );

    const {
        data: dashboardData,
        error: swrError,
        isLoading,
        isValidating,
        mutate,
        reset: resetDashboard,
        dispose,
    } = swrResult;

    // Turnover and runway need the stock rows next to the orders. The cache key is
    // the same one the stocks page uses, so moving between the two pages reuses the
    // payload instead of refetching it.
    const stocksResult = useSWR(
        `ozon-stocks:${clientId}`,
        async (signal) => {
            if (!$ozonKeys.clientId || !$ozonKeys.apiKey) {
                throw new Error(
                    "Укажите Client ID и API Key в настройках (шестерёнка справа сверху).",
                );
            }
            return getStocksData(signal);
        },
        { dedupingInterval: 2000, refreshInterval: 5 * 60 * 1000 },
    );

    const {
        data: stocksData,
        error: stocksError,
        isLoading: stocksLoading,
        mutate: mutateStocks,
        reset: resetStocks,
        dispose: disposeStocks,
    } = stocksResult;

    // --- The financial layer: accruals, the money that actually arrives ---
    //
    // `/v1/finance/accrual/by-day` answers for one day at a time, so the window is
    // fetched once and kept in localStorage. Closed days never change, so later visits ask
    // only for the two trailing days instead of walking the whole window again.

    // Order-derived state first: everything below builds on it.
    const postingsData = $derived($dashboardData?.postings ?? []);
    // Cancelled orders earn nothing, so every money figure leaves them out.
    const paidPostings = $derived(
        postingsData.filter((posting) => posting.status !== "cancelled"),
    );
    const error = $derived(describeFailure($swrError));

    // --- The selected month ---
    //
    // Every money section follows this one control, so the figures on screen always belong
    // to a single, named period. It is a calendar month and nothing else: the realization
    // report and the accrual statements are monthly documents, and a trailing window can
    // never be reconciled against them.
    //
    // `periodMonth` itself is declared at the top, above the requests that read it.
    const periodDayList = $derived(daysOfMonth(periodMonth));
    const periodDaySet = $derived(new Set(periodDayList));
    const periodLabel = $derived(monthLabel(periodMonth));
    // The month before, so one can be read against the other.
    const previousMonth = $derived(previousMonthKey(periodMonth));
    const previousPeriodDayList = $derived(daysOfMonth(previousMonth));
    const previousLabel = $derived(monthLabel(previousMonth));
    // Accruals are fetched for both months at once; the endpoint caps the request at 62 days,
    // which is exactly two months, so the comparison costs nothing extra to keep fresh. The
    // period cards add their own two months — the one that closed and the one running — and
    // the union is what gets fetched and kept.
    const financeFetchDays = $derived(
        [...new Set([...periodDayList, ...previousPeriodDayList, ...cardAccrualDays()])].sort(),
    );
    // Months come from the calendar, not from the loaded orders: the point of the month mode
    // is to reach periods the order feed cannot cover, and the realization report answers for
    // any month — December 2025 was verified to return data.
    const MONTHS_BACK = 24;
    const availableMonthList = $derived(recentMonths(new Date(), MONTHS_BACK));

    // The dashboard loads a bounded history, so an older month cannot be shown in full.
    // Saying so matters: otherwise a partial month reads as a collapse in sales.
    const loadedFromDay = $derived.by(() => {
        const days = postingsData
            .map((posting) => new Date(posting.created_at))
            .filter((date) => !Number.isNaN(date.getTime()))
            .map((date) => dayKey(date))
            .sort();

        return days[0] ?? null;
    });
    const periodIsPartial = $derived(
        loadedFromDay !== null &&
            periodDayList.length > 0 &&
            periodDayList[0] < loadedFromDay,
    );
    /** True when the loaded order history does not reach the selected period at all. */
    const periodHasNoOrders = $derived(
        periodIsPartial &&
            postingsData.length > 0 &&
            !postingsData.some((posting) => isInsidePeriod(posting.created_at, periodDaySet)),
    );

    function accrualStorageKey() {
        return `ozon_accruals:${clientId}`;
    }

    function readAccrualCache(): AccrualCache {
        try {
            const raw = localStorage.getItem(accrualStorageKey());
            if (!raw) return emptyAccrualCache();

            const parsed = JSON.parse(raw) as AccrualCache;
            if (!parsed || typeof parsed !== "object" || typeof parsed.days !== "object") {
                return emptyAccrualCache();
            }

            return {
                days: parsed.days ?? {},
                types: parsed.types ?? {},
                fetchedAt: parsed.fetchedAt ?? null
            };
        } catch {
            // A damaged cache must not stop the page from rendering.
            return emptyAccrualCache();
        }
    }

    function writeAccrualCache(cache: AccrualCache) {
        try {
            localStorage.setItem(accrualStorageKey(), JSON.stringify(cache));
        } catch {
            // Quota is not a reason to lose the data already on screen.
        }
    }

    /**
     * Splits the days to fetch into requests the accrual endpoint accepts.
     *
     * It keeps the tail of a list longer than 62 days, and a silently dropped month would read
     * as a period Ozon accrued nothing for — the exact failure the accrual layer exists to
     * prevent. Chunking keeps every requested day requested.
     */
    function chunkDays(days: string[], size: number): string[][] {
        const chunks: string[][] = [];

        for (let index = 0; index < days.length; index += size) {
            chunks.push(days.slice(index, index + size));
        }

        return chunks;
    }

    const economicsResult = useSWR(
        `ozon-economics:${clientId}`,
        async (signal) => {
            if (!$ozonKeys.clientId || !$ozonKeys.apiKey) {
                throw new Error(
                    "Укажите Client ID и API Key в настройках (шестерёнка справа сверху).",
                );
            }

            const cache = readAccrualCache();
            // The selected month decides which days are needed, so choosing an earlier month
            // fetches that month and leaves the others cached.
            const window = financeFetchDays;
            const missing = daysToFetch(cache, window);
            const needsTypes = Object.keys(cache.types).length === 0;

            if (missing.length === 0 && !needsTypes) return cache;

            // The endpoint keeps only the last 62 days of a longer list, so a wider union is
            // split into requests of its own size rather than silently truncated: a dropped
            // day would read as a period with no accruals at all. Two requests at most — the
            // union is the selected month, the month before it, and the cards' two months.
            const chunks = chunkDays(missing, MAX_ACCRUAL_DAYS);
            const payloads = await Promise.all(
                (chunks.length > 0 ? chunks : [[]]).map((dates, index) =>
                    getEconomicsData(signal, dates, needsTypes && index === 0),
                ),
            );

            let merged = cache;
            for (const payload of payloads) {
                merged = mergeAccrualDays(merged, payload.days, payload.types, payload.fetchedAt);
            }

            const kept = pruneAccrualCache(merged, financeFetchDays);
            writeAccrualCache(kept);

            return kept;
        },
        // Day-level data: a slow refresh is enough, and every poll costs requests.
        { dedupingInterval: 2000, refreshInterval: 30 * 60 * 1000 },
    );

    const {
        data: financeData,
        error: financeError,
        isLoading: financeLoading,
        isValidating: financeValidating,
        mutate: mutateFinance,
        reset: resetFinance,
        dispose: disposeFinance,
    } = economicsResult;

    // --- The selected month, straight from Ozon's monthly documents ---
    //
    // The order feed is bounded, so it can never answer for March. The realization report
    // is monthly and the API serves it for any month, which is what makes older months
    // reachable at all.
    const monthFinanceResult = useSWR(
        `ozon-month-finance:${clientId}`,
        async (signal) => {
            if (!$ozonKeys.clientId || !$ozonKeys.apiKey) {
                throw new Error(
                    "Укажите Client ID и API Key в настройках (шестерёнка справа сверху).",
                );
            }

            // Recorded before the fetch so a failure can be attributed to the month it was
            // asked for. Ozon answers 404 for a month it has not closed yet — its report
            // appears only afterwards — and that is reported as a state, not an error.
            requestedMonth = periodMonth;

            return getMonthFinance(signal, periodMonth);
        },
        { dedupingInterval: 5000 },
    );

    const {
        data: monthFinanceData,
        error: monthFinanceError,
        isLoading: monthFinanceLoading,
        isValidating: monthFinanceValidating,
        mutate: mutateMonthFinance,
        dispose: disposeMonthFinance,
    } = monthFinanceResult;

    /**
     * The realization report of the cards' own month.
     *
     * It is asked for separately because the cards are anchored to today while the month
     * selector is free: choosing June leaves the section's own month — the previous calendar
     * month — outside everything the page has loaded. Only the report is fetched, since a
     * revenue-based tax needs nothing else from that month.
     *
     * The month is recorded before the request for the same reason the selector records its
     * own: an answer must never be displayed under a month it does not belong to.
     */
    let requestedCardMonth = $state<string | null>(null);

    const cardMonthFinanceResult = useSWR(
        `ozon-card-realization:${clientId}`,
        async (signal) => {
            if (!$ozonKeys.clientId || !$ozonKeys.apiKey) {
                throw new Error(
                    "Укажите Client ID и API Key в настройках (шестерёнка справа сверху).",
                );
            }

            requestedCardMonth = cardMonth;
            return getMonthRealization(signal, cardMonth);
        },
        { dedupingInterval: 5000 },
    );

    const {
        data: cardMonthData,
        error: cardMonthError,
        dispose: disposeCardMonth,
    } = cardMonthFinanceResult;

    // Switching the month changes which days the accruals must cover; the SWR closures are
    // not reactive, so the refetch is asked for explicitly.
    let lastRequestedPeriod = $state("");
    $effect(() => {
        const key = periodMonth;
        if (lastRequestedPeriod === "") {
            lastRequestedPeriod = key;
            return;
        }
        if (lastRequestedPeriod === key) return;

        lastRequestedPeriod = key;
        void mutateFinance({ force: true });
        // The monthly block follows the same control, so it reloads with it.
        void mutateMonthFinance({ force: true });
        // Orders too: the window that covers the month changes with it, and the fetch decides
        // whether that means the recent tail again or the whole window.
        void mutate({ force: true });
    });

    const accrualDays = $derived(
        $financeData ? cachedWindow($financeData, periodDayList) : [],
    );
    const finance = $derived(
        summariseFinance(accrualDays, $financeData?.types ?? {}),
    );

    // The same figures for the window before, so a month reads against its predecessor.
    const previousAccrualDays = $derived(
        $financeData ? cachedWindow($financeData, previousPeriodDayList) : [],
    );
    const previousFinance = $derived(
        summariseFinance(previousAccrualDays, $financeData?.types ?? {}),
    );
    // A delta is only meaningful when the whole previous window is on hand. Part of it would
    // compare a month against a fragment and call the difference growth.
    const previousComplete = $derived(
        previousPeriodDayList.length > 0 &&
            previousAccrualDays.length === previousPeriodDayList.length,
    );    const financeDeltaPct = $derived(
        previousComplete && previousFinance.net !== 0
            ? ((finance.net - previousFinance.net) / Math.abs(previousFinance.net)) * 100
            : null,
    );

    // Delivered orders Ozon has not accrued for yet: normal for a day or two, a payout
    // delay or a broken feed beyond that.
    const inTransit = $derived(
        moneyInTransit(
            accrualDays,
            paidPostings.map((posting) => ({
                posting_number: posting.posting_number,
                status: posting.status,
                created_at: posting.created_at,
                expectedPayout: posting.financial_products.reduce<number | null>(
                    (sum, row) =>
                        typeof row.payout === "number" ? (sum ?? 0) + row.payout : sum,
                    null,
                ),
            })),
            new Date(),
        ),
    );

    // Reload when the credentials change; useSWR already loads the initial value.
    // Both requests are reset first, so the previous account's payload is dropped
    // before the new one is fetched — otherwise it would stay on screen and get
    // merged into the new account's data.
    refreshOnKeysChange(() => {
        resetDashboard();
        resetStocks();
        resetFinance();
        mutate({ force: true });
        mutateStocks({ force: true });
        mutateFinance({ force: true });
    });

    // Clean up resources when component is destroyed
    onDestroy(dispose);
    onDestroy(disposeStocks);
    onDestroy(disposeFinance);
    onDestroy(disposeMonthFinance);
    onDestroy(disposeCardMonth);

    const pad = (value: number) => String(value).padStart(2, "0");

    /** Wall-clock time of the payload currently on screen. */
    function formatTime(date: Date) {
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    // The skeleton state owns the whole analytics area: without it every figure
    // would render as a zero while the 31-day load is still running, which reads as
    // "you sold nothing today".
    const showSkeletons = $derived($isLoading);

    // An error with nothing cached leaves nothing truthful to draw, so the sections
    // are replaced by one explanation instead of a wall of zeros.
    const nothingToShow = $derived(Boolean(error) && postingsData.length === 0);

    // Stale-but-present data: the last refresh failed, so what is on screen is old.
    const showingStaleData = $derived(Boolean(error) && postingsData.length > 0);

    // Recomputed whenever the postings change.
    const stats = $derived(calculateStats(postingsData));

    // The two charts follow the same month as the money sections, so one page has one period
    // and one definition of it.
    const analysisWindow = $derived.by(() => {
        const [year, month] = periodMonth.split("-").map(Number);
        // Day 0 of the following month is the last day of this one.
        const lastDay = new Date(year, month, 0).getDate();

        return {
            end: new Date(year, month - 1, lastDay, 23, 59, 59),
            days: lastDay,
        };
    });

    // --- The month on screen, as opposed to the whole payload ---
    //
    // Declared here because the breakdowns below are scoped to it. Cancelled orders earn
    // nothing, so they are out of every money figure.
    const moneyWindow = $derived(
        paidPostings.filter((posting) => isInsidePeriod(posting.created_at, periodDaySet)),
    );

    // --- Tier 2: breakdowns derived from the postings already in memory ---
    //
    // These aggregate whatever they are handed, so they are handed the month on screen and
    // not the whole payload. The payload can hold two disjoint ranges — an old month beside
    // today's tail, which is how a month a year back is fetched without walking the year in
    // between — and an aggregation across both would mix orders a twelvemonth apart.
    const trend = $derived(
        dailyTrend(postingsData, analysisWindow.days, analysisWindow.end),
    );
    const trendMax = $derived(Math.max(1, ...trend.map((point) => point.netRevenue)));

    const top = $derived(topProducts(moneyWindow, 8));
    const concentration = $derived(revenueConcentration(moneyWindow));
    const cities = $derived(byCity(moneyWindow, 6));
    const payments = $derived(byPaymentType(moneyWindow, 5));
    const routes = $derived(clusterRoutes(moneyWindow, 6));
    const actionStats = $derived(actionBreakdown(moneyWindow, 6));
    const promo = $derived(promoShare(moneyWindow));

    // Orders by local hour: answers "at what time do customers buy".
    const hours = $derived(
        hourlyActivity(postingsData, analysisWindow.days, analysisWindow.end),
    );
    const hoursMax = $derived(Math.max(1, ...hours.map((point) => point.orders)));
    const peakHour = $derived(
        hours.reduce(
            (best, point) => (point.orders > best.orders ? point : best),
            hours[0],
        ),
    );

    // --- Tier 3: joins sales with the stock rows loaded above ---
    const stockRows = $derived($stocksData?.items ?? []);
    const stocksLoadError = $derived($stocksError?.message ?? null);

    // Three distinct states, never collapsed into one: still loading, failed, or
    // genuinely empty. Collapsing them is what made a failed request look like
    // "there is no stock at all".
    const stocksLoadingNow = $derived($stocksLoading);
    const stocksFailed = $derived(stocksLoadError !== null && stockRows.length === 0);
    const stocksEmpty = $derived(
        !$stocksLoading && stocksLoadError === null && stockRows.length === 0,
    );

    // Without stock rows every selling SKU would look out of stock, so the join is
    // only run once the inventory payload has arrived.
    const inventory = $derived(
        stockRows.length > 0
            ? inventoryInsights(postingsData, stockRows)
            : inventoryInsights([], []),
    );

    // --- Margin, which needs a cost price the API cannot supply ---
    //
    // Ozon reports `payout` and `commission` inside `financial_data` of the same free
    // endpoint the orders come from, so unit economics needs no paid method.
    //
    // Costs are resolved per order date, so a margin for an old period uses the price
    // that applied then instead of today's.
    const costs = $derived(costBookLookup($costBook));
    const skuRows = $derived(skuEconomics(moneyWindow, costs));

    // --- The four "right now" cards ---
    //
    // Anchored to today rather than to the month selector, because that is what "now" means:
    // the section sits above every month-scoped figure precisely so the shop can be read
    // without choosing anything. Each card is assembled from the same four sources as the
    // rest of the page — orders, accruals, returns and the cost book — and every money figure
    // is withheld rather than guessed when one of them is missing.
    /** The figures of one window — a card's, or the window it is compared against. */
    interface CardMeasurements {
        orders: OrdersTotals;
        returns: ReturnsTotals;
        accrual: AccrualTotals;
        cost: CogsTotals;
        profit: CardProfit;
    }

    /** Everything one card knows, which is what its tooltips explain. */
    interface CardFigures extends CardMeasurements {
        window: {
            open: boolean;
            label: string;
            range: string;
            from: string;
            to: string;
            compare: { from: string; to: string; range: string; short: string } | null;
        };
        /**
         * The window the percentage is measured against, or `null` where there is none.
         *
         * A change with no visible base is a number the reader has to guess at, which is what
         * «+62,9 %» on the card was: it now names the window, and the breakdown states both
         * figures — so the reader can check the arithmetic instead of trusting the sign.
         */
        previous: CardMeasurements | null;
    }

    /** One row of a tooltip: a name on the left, a figure on the right. */
    interface TipRow {
        label: string;
        value: string;
        /**
         * `sub` is a part of the row above it, not a sibling: a breakdown nested inside its
         * own total, so nobody adds a part to the total it already belongs to.
         */
        tone?: "total" | "aside" | "minus" | "sub";
    }

    /** What each metric of a card is made of. */
    type CardMetric = "sales" | "orders" | "cancelled" | "returns" | "adv" | "payout" | "profit";

    /**
     * The arithmetic behind one metric, as rows for its tooltip.
     *
     * Kept here rather than in the markup: seven metrics across four cards is twenty-eight
     * explanations, and written inline they would bury the layout they belong to. Every figure
     * comes from the same card object the metric itself renders, so a tooltip cannot drift from
     * the number it explains — which is the whole point of showing it.
     */
    function tipRows(
        card: CardFigures,
        metric: CardMetric,
    ): { rows: TipRow[]; footer: string } {
        const types = $financeData?.types ?? {};
        const settings = $taxSettings;
        const money = (value: number) => formatCurrency(value);
        // Breakdowns are formatted with kopecks: their parts have to visibly make the whole.
        const exact = (value: number) => formatCurrencyPrecise(value);
        const count = (value: number) => formatNumber(value);
        const share = (value: number) => formatPercent(value * 100, 1);
        const percent = String(settings.percent).replace(".", ",");
        const days = Math.max(1, card.accrual.expected || daysBetween(card.window.from, card.window.to).length);
        const perDay = (value: number) => money(value / days);

        const sales = card.orders.sales;
        const allOrders = card.orders.orders + card.orders.cancelled;
        const cancelledSum = card.orders.cancelledSum;
        const grossMoney = sales + cancelledSum;

        if (metric === "sales") {
            /*
                The percentage on the card is a change against a window of the same shape: a day
                against a day, the month so far against the same days of the previous month. An
                open window has no percentage at all — a part compared to a whole reads as a
                collapse — and the row says so rather than staying silent. Where the two windows
                differ in length, the footer says that too, because a 30-day month against a
                31-day one carries three per cent of length in the comparison.
            */
            const comparison: TipRow[] = [];
            const compareWindow = card.window.compare;
            if (card.window.open) {
                comparison.push({
                    label: "Сравнение",
                    value: "не показано: окно ещё не закрыто",
                    tone: "aside",
                });
            } else if (compareWindow && card.previous) {
                const change = deltaPercent(sales, card.previous.orders.sales);
                comparison.push({
                    label: `Sales в окне сравнения — ${compareWindow.range}`,
                    value: exact(card.previous.orders.sales),
                    tone: "aside",
                });
                comparison.push({
                    label: "Изменение к нему",
                    value: formatDelta(change),
                    tone: "aside",
                });
            }

            return {
                rows: [
                    { label: "Заказов без отмен", value: count(card.orders.orders) },
                    { label: "Штук", value: count(card.orders.units) },
                    {
                        label: "Средняя цена штуки",
                        value: card.orders.units > 0 ? money(sales / card.orders.units) : "—",
                    },
                    {
                        label: "Средний заказ",
                        value: card.orders.orders > 0 ? money(sales / card.orders.orders) : "—",
                    },
                    {
                        label: "Отменено",
                        value:
                            card.orders.cancelled > 0
                                ? `${count(card.orders.cancelled)} на ${money(cancelledSum)}`
                                : "нет",
                        tone: "minus",
                    },
                    {
                        label: "Кросс-кластерных отправлений",
                        value: count(card.orders.crossCluster),
                        tone: "aside",
                    },
                    { label: "В среднем в день", value: perDay(sales), tone: "aside" },
                    ...comparison,
                ],
                footer:
                    `Цена продавца по не отменённым заказам, созданным в окне «${card.window.range}». ` +
                    "Это деньги покупателя: комиссия Ozon, логистика, эквайринг и реклама из них ещё " +
                    "не вычтены, поэтому Sales не равен тому, что придёт на счёт. Кросс-кластерные " +
                    "отправления — те, что едут между кластерами: логистика по ним дороже. Источник — " +
                    "лента заказов /v3/posting/fbo/list по дате создания заказа." +
                    (card.window.open
                        ? ""
                        : ` Процент на плашке — изменение Sales к окну «${compareWindow?.range}»: ` +
                          (compareWindow && daysBetween(compareWindow.from, compareWindow.to).length !== days
                              ? `окна разной длины (${count(days)} против ` +
                                `${count(daysBetween(compareWindow.from, compareWindow.to).length)} дн.), ` +
                                "поэтому в проценте есть и разница в длине периода."
                              : "окна одной длины, так что изменение — это изменение продаж.")),
            };
        }

        if (metric === "orders") {
            return {
                rows: [
                    { label: "Заказов", value: count(card.orders.orders) },
                    { label: "Штук", value: count(card.orders.units) },
                    {
                        label: "Штук в заказе",
                        value:
                            card.orders.orders > 0
                                ? (card.orders.units / card.orders.orders).toFixed(2).replace(".", ",")
                                : "—",
                    },
                    {
                        label: "Средний чек",
                        value: card.orders.orders > 0 ? money(sales / card.orders.orders) : "—",
                    },
                    {
                        label: "Отменено",
                        value:
                            card.orders.cancelled > 0
                                ? `${count(card.orders.cancelled)} заказов · ${count(card.orders.cancelledUnits)} шт`
                                : "нет",
                        tone: "minus",
                    },
                    {
                        label: "Доля отмен",
                        value: allOrders > 0 ? share(card.orders.cancelled / allOrders) : "—",
                        tone: "aside",
                    },
                    { label: "Заказов в день", value: perDay(card.orders.orders), tone: "aside" },
                ],
                footer:
                    "Считается по дате создания заказа, а не по дате отгрузки: «сегодня» — это " +
                    "оформленные сегодня заказы, а не отправленные. Отменённые заказы показаны " +
                    "отдельной строкой и в Orders / Units не входят. Окно — " +
                    `${card.window.range}, ${count(days)} дн.`,
            };
        }

        if (metric === "cancelled") {
            return {
                rows: [
                    { label: "Заказов", value: count(card.orders.cancelled) },
                    { label: "Штук", value: count(card.orders.cancelledUnits) },
                    { label: "Сумма по цене продавца", value: money(cancelledSum) },
                    {
                        label: "Доля отказов",
                        value: allOrders > 0 ? share(card.orders.cancelled / allOrders) : "—",
                    },
                    {
                        label: "Потеряно от выручки окна",
                        value: grossMoney > 0 ? share(cancelledSum / grossMoney) : "—",
                        tone: "aside",
                    },
                ],
                footer:
                    "Заказы со статусом cancelled, созданные в окне. В Sales, Orders / Units и в " +
                    "прибыли они не участвуют: отменённый заказ денег не приносит. «Потеряно от " +
                    "выручки окна» — доля отменённых денег в сумме заказов вместе с отменёнными, " +
                    "то есть ответ на вопрос «сколько мы недополучили из-за отказов».",
            };
        }

        if (metric === "returns") {
            const rows: TipRow[] = [
                { label: "Возвратов", value: count(card.returns.count) },
                { label: "Штук", value: count(card.returns.units) },
            ];

            // Parts first, the total after them: a sum that appears above its own terms reads as
            // one more independent number.
            if (card.returns.notPickedUp.count > 0) {
                rows.push({
                    label: `не забрали заказ · ${count(card.returns.notPickedUp.count)} шт`,
                    value: exact(card.returns.notPickedUp.amount),
                    tone: "sub",
                });
            }
            if (card.returns.clientReturn.count > 0) {
                rows.push({
                    label: `вернули после получения · ${count(card.returns.clientReturn.count)} шт`,
                    value: exact(card.returns.clientReturn.amount),
                    tone: "sub",
                });
            }
            if (card.returns.other.count > 0) {
                rows.push({
                    label: `прочие типы · ${count(card.returns.other.count)} шт`,
                    value: exact(card.returns.other.amount),
                    tone: "sub",
                });
            }

            rows.push({
                label: "Сумма по цене продажи",
                value: exact(card.returns.amount),
                tone: "total",
            });

            const soldUnits = card.orders.units + card.returns.units;
            rows.push({
                label: "Доля от проданных штук",
                value: soldUnits > 0 ? share(card.returns.units / soldUnits) : "—",
                tone: "aside",
            });

            return {
                rows,
                footer:
                    "Возвраты, оформленные в окне: дата — logistic.return_date из реестра " +
                    "/v1/returns/list, а не дата заказа. Из Sales они не вычитаются: возврат " +
                    "приходит своей датой и своими деньгами, а сумма здесь — цена продажи " +
                    "возвращённых штук, не сумма возврата покупателю. «Не забрали» — покупатель не " +
                    "пришёл за заказом, «вернули» — забрал и принёс обратно.",
            };
        }

        if (metric === "adv") {
            if (!card.accrual.complete) {
                return {
                    rows: [
                        {
                            label: "Дней с начислениями",
                            value: `${count(card.accrual.loaded)} из ${count(card.accrual.expected)}`,
                            tone: "aside",
                        },
                    ],
                    footer:
                        "Начисления за это окно загружены не полностью, поэтому рекламные удержания " +
                        "не показаны: часть их выглядела бы как весь расход. За сегодня начисления " +
                        "приходят на следующий день.",
                };
            }

            const rows: TipRow[] = Object.entries(card.accrual.advertisingByType)
                .sort((a, b) => b[1] - a[1])
                .map(([typeId, amount]) => ({
                    label: types[typeId] ?? `Вид удержания ${typeId}`,
                    value: exact(amount),
                    tone: "sub" as const,
                }));

            rows.push({
                label: "Итого реклама",
                value: exact(card.accrual.advertising),
                tone: "total",
            });
            rows.push({
                label: "ДРР от Sales",
                value: sales > 0 ? share(card.accrual.advertising / sales) : "—",
                tone: "aside",
            });
            rows.push({
                label: "Доля в начислении",
                value:
                    card.accrual.net !== 0
                        ? share(card.accrual.advertising / Math.abs(card.accrual.net))
                        : "—",
                tone: "aside",
            });
            rows.push({
                label: "В среднем в день",
                value: perDay(card.accrual.advertising),
                tone: "aside",
            });

            return {
                rows,
                footer:
                    "Рекламные удержания Ozon из начислений за окно: оплата за клик и соседние " +
                    "механики (виды 41, 54, 33, 23, 87, 130, названия — из справочника " +
                    "/v1/finance/accrual/types). Они уже вычтены внутри Est. payout, поэтому " +
                    "отдельно из прибыли не вычитаются. ДРР — доля рекламных расходов от Sales; у " +
                    "Ozon в кабинете она считается от продаж, здесь — от цены продавца в окне.",
            };
        }

        if (metric === "payout") {
            if (!card.accrual.complete) {
                return {
                    rows: [
                        {
                            label: "Дней с начислениями",
                            value: `${count(card.accrual.loaded)} из ${count(card.accrual.expected)}`,
                            tone: "aside",
                        },
                    ],
                    footer:
                        "Начисления за это окно ещё не пришли целиком: сумма не показана, чтобы часть " +
                        "не выглядела как целое. За сегодня начисления приходят на следующий день — " +
                        "цифра появится завтра.",
                };
            }

            const categoryLabels: Record<string, string> = {
                POSTING: "начисления на отправления",
                ITEM: "начисления на товары (эквайринг)"
            };

            /*
                One hierarchy, not two overlapping splits. The cabinet's own costs ARE the
                NON_ITEM category and the orders ARE POSTING plus ITEM — checked against the
                live account for September 2026, where 155 245,22 − 5 289,72 = 149 955,50 ₽ of
                orders and −12 741,79 ₽ of cabinet costs. Showing both splits side by side, as
                this tooltip first did, printed the same 12 742 ₽ twice and invited the reader to
                add numbers that must not be added.
            */
            const rows: TipRow[] = [
                { label: "По заказам", value: exact(card.accrual.orders) }
            ];

            for (const [category, label] of Object.entries(categoryLabels)) {
                const amount = card.accrual.byCategory[category];
                if (typeof amount !== "number" || amount === 0) continue;
                rows.push({ label, value: exact(amount), tone: "sub" });
            }

            rows.push({
                label: "Расходы кабинета (NON_ITEM)",
                value: exact(card.accrual.cabinet),
                tone: "minus"
            });
            rows.push({
                label: "в том числе реклама",
                value: exact(card.accrual.advertising),
                tone: "sub"
            });
            rows.push({
                label: "Итого начислено",
                value: exact(card.accrual.net),
                tone: "total"
            });
            rows.push({
                label: `За ${count(days)} дн., в среднем`,
                value: money(card.accrual.net / days),
                tone: "aside"
            });

            return {
                rows,
                footer:
                    `Сумма total_amount по ${count(card.accrual.loaded)} дн. окна «${card.window.range}» — ` +
                    "то, что Ozon начислил за эти дни. Категории Ozon: POSTING — начисление на " +
                    "отправление (цена минус комиссия и услуги), ITEM — начисление на товар, " +
                    "включая эквайринг, NON_ITEM — расходы кабинета: хранение, реклама, кросс-докинг. " +
                    "Расходы кабинета и есть NON_ITEM, а по заказам — это POSTING плюс ITEM, поэтому " +
                    "строки не складываются друг с другом: части вложены в свои итоги. Суммы показаны " +
                    "с копейками, чтобы части сходились с итогом: в рублях округление разошлось бы на " +
                    "рубль. На счёт приходит позже, недельными выплатами, а не в день начисления." +
                    (card.window.open
                        ? " За сегодня начисления приходят на следующий день, поэтому цифра ещё вырастет."
                        : ""),
            };
        }

        // Net profit: the chain itself, and the reason a link may be missing.
        const rows: TipRow[] = [];
        if (card.profit.payout !== null) {
            rows.push({ label: "Начислено", value: exact(card.profit.payout) });
        }
        if (card.profit.cogs !== null) {
            rows.push({ label: "Себестоимость проданного", value: exact(card.profit.cogs), tone: "minus" });
            if (card.cost.units > 0) {
                rows.push({
                    label: `за штуку (в среднем по ${count(card.cost.units)} шт)`,
                    value: money(card.profit.cogs / card.cost.units),
                    tone: "aside",
                });
            }
        }
        if (card.profit.tax !== null) {
            rows.push({
                label: `Налог ${percent}% (${TAX_BASE_LABELS[settings.base]})`,
                value: exact(card.profit.tax),
                tone: "minus",
            });
        }
        if (card.profit.taxable !== null) {
            rows.push({ label: "База налога", value: exact(card.profit.taxable), tone: "aside" });
        }
        if (card.profit.netProfit !== null) {
            rows.push({ label: "Остаётся", value: exact(card.profit.netProfit), tone: "total" });
            if (card.profit.payout !== null && card.profit.payout !== 0) {
                rows.push({
                    label: "Маржа от начисления",
                    value: share(card.profit.netProfit / card.profit.payout),
                    tone: "aside",
                });
            }
            // The second percentage on a card, explained the same way as the first.
            const compareWindow = card.window.compare;
            const was = card.previous?.profit.netProfit ?? null;
            if (card.window.open) {
                rows.push({
                    label: "Сравнение",
                    value: "не показано: окно ещё не закрыто",
                    tone: "aside",
                });
            } else if (compareWindow && was !== null) {
                rows.push({
                    label: `Остаётся в окне сравнения — ${compareWindow.range}`,
                    value: exact(was),
                    tone: "aside",
                });
                rows.push({
                    label: "Изменение к нему",
                    value: formatDelta(deltaPercent(card.profit.netProfit, was)),
                    tone: "aside",
                });
            }
        }
        if (!card.profit.costKnown && card.cost.units > 0) {
            rows.push({
                label: "Себестоимость известна для",
                value: `${count(card.cost.coveredUnits)} из ${count(card.cost.units)} шт`,
                tone: "aside",
            });
        }

        const parts = [
            `Цепочка: начислено минус себестоимость проданного и налог, окно «${card.window.range}».`,
        ];
        if (card.profit.taxable === null) {
            parts.push(
                "База налога — реализованное за вычетом возвратов, а её знает только месячный отчёт " +
                    "Ozon: за незакрытый месяц его не существует, поэтому чистая прибыль не показана.",
            );
        } else {
            parts.push(
                `Налог: ${percent}% от базы «${TAX_BASE_LABELS[settings.base]}», то есть от ${money(card.profit.taxable)}.`,
            );
        }
        if (!card.profit.costKnown && card.cost.units > 0) {
            parts.push(
                `Себестоимость известна для ${share(card.cost.coveredUnits / card.cost.units)} проданных штук — ` +
                    "прибыль не показывается, пока не покрыты все: подставить ноль значило бы выдать " +
                    "отсутствие данных за убыток. Заполнить её можно кнопкой «Себестоимость» в " +
                    "заголовке раздела «Месяц · деньги: от реализации до счёта».",
            );
        } else if (card.profit.costKnown) {
            parts.push(
                "Себестоимость берётся из вашей книги на дату заказа, а проданные штуки — по отчёту " +
                    "о реализации; единицы с возвратами из себестоимости вычтены.",
            );
        }
        parts.push(
            "Реклама отдельно не вычитается: она уже внутри начисления, эта же величина показана " +
                "строкой Adv. cost.",
        );

        return { rows, footer: parts.join(" ") };
    }

    /**
     * The one-line hint under a figure, so the tooltip does not have to be opened to read it.
     *
     * The card carries what is worth knowing at a glance — the split behind a payout, the tax
     * inside a profit, the reason a figure is missing — and the tooltip keeps the rest. Written
     * as a function for the same reason the rows are: twenty-eight texts is not markup.
     */
    function cardNote(card: CardFigures, metric: CardMetric): string | undefined {
        const money = (value: number) => formatCurrency(value);
        const share = (value: number) => formatPercent(value * 100, 1);

        if (metric === "sales") {
            return card.orders.units > 0
                ? `${money(card.orders.sales / card.orders.units)} за штуку`
                : undefined;
        }

        if (metric === "orders") {
            return card.orders.orders > 0
                ? `${money(card.orders.sales / card.orders.orders)} средний чек`
                : undefined;
        }

        if (metric === "cancelled") {
            const all = card.orders.orders + card.orders.cancelled;
            if (card.orders.cancelled === 0) return "отказов нет";
            return all > 0 ? `${share(card.orders.cancelled / all)} всех заказов` : undefined;
        }

        if (metric === "returns") {
            if (card.returns.count === 0) return "возвратов нет";
            const parts: string[] = [];
            if (card.returns.notPickedUp.count > 0) {
                parts.push(`не забрали ${formatNumber(card.returns.notPickedUp.count)}`);
            }
            if (card.returns.clientReturn.count > 0) {
                parts.push(`вернули ${formatNumber(card.returns.clientReturn.count)}`);
            }
            return parts.join(" · ");
        }

        if (metric === "adv") {
            if (!card.accrual.complete) return "начисления за окно ещё не пришли";
            if (card.orders.sales <= 0 || card.accrual.advertising === 0) return undefined;
            return `ДРР ${share(card.accrual.advertising / card.orders.sales)} от Sales`;
        }

        if (metric === "payout") {
            if (!card.accrual.complete) return "начисления приходят на следующий день";
            const cabinet = card.accrual.cabinet;
            return (
                `по заказам ${formatCurrencyPrecise(card.accrual.orders)} · кабинет ` +
                `${cabinet < 0 ? "−" : ""}${formatCurrencyPrecise(Math.abs(cabinet))}`
            );
        }

        // Net profit: the tax that was charged, or why no figure is shown.
        if (card.profit.netProfit !== null) {
            const tax = card.profit.tax !== null ? `налог ${money(card.profit.tax)}` : null;
            const margin =
                card.profit.payout !== null && card.profit.payout !== 0
                    ? `маржа ${share(card.profit.netProfit / card.profit.payout)}`
                    : null;
            return [tax, margin].filter(Boolean).join(" · ") || undefined;
        }
        if (card.profit.taxable === null) return "нет базы налога: месяц не закрыт";
        if (!card.profit.costKnown && card.cost.units > 0) {
            return `себестоимость: ${share(card.cost.coveredUnits / card.cost.units)} штук`;
        }
        if (card.profit.payout === null) return "начисления ещё не пришли";
        return undefined;
    }

    const returnsFeed = $derived($dashboardData?.returns ?? []);
    // The cards' own month, if its report has arrived and belongs to the month asked for.
    const cardRealization = $derived(
        monthView(
            cardMonth,
            requestedCardMonth,
            $cardMonthData,
            $cardMonthError as { status?: number; message?: string } | null,
        ).data?.realization ?? null,
    );
    const periodCards = $derived.by(() => {
        const settings = $taxSettings;
        const days = $financeData?.days ?? {};

        /**
         * The closed month's own figures: realized revenue minus returns, and the cost of the
         * goods that report says were sold. Everything else in the section has neither, which
         * is why the daily cards charge a revenue-based tax on nothing at all.
         */
        const cardBounds = monthBounds(cardMonth);
        const monthly = cardRealization
            ? {
                  realized: cardRealization.net,
                  cost: realizationCost(
                      cardRealization.perSku,
                      cardBounds ? new Date(`${cardBounds.to}T23:59:59`) : new Date(),
                      costs,
                  ),
              }
            : null;

        /** One window's figures, so a card and its comparison are built the same way. */
        const measure = (
            from: string,
            to: string,
            closedMonth?: { realized: number; cost: CogsTotals },
        ) => {
            const orders = ordersTotals(postingsData, from, to);
            const returns = returnsTotals(returnsFeed, from, to);
            const accrual = accrualTotals(days, daysBetween(from, to));
            const cost = closedMonth
                ? closedMonth.cost
                : costOfGoods(postingsData, returnsFeed, from, to, costs);
            const profit = cardProfit({
                accrual,
                // The order feed's seller price is not the realized revenue: it is nearly twice
                // it, because it includes the discount Ozon funds itself. Only the monthly
                // report states the figure the tax is charged on.
                realized: closedMonth ? closedMonth.realized : null,
                cost,
                taxPercent: settings.percent,
                base: settings.base,
            });

            return { orders, returns, accrual, cost, profit };
        };

        return cardWindows().map((window) => {
            const current = measure(
                window.from,
                window.to,
                window.key === 'lastMonth' ? (monthly ?? undefined) : undefined,
            );
            const previous = window.compare
                ? measure(window.compare.from, window.compare.to)
                : null;

            // An open window is compared to nothing: today against a finished yesterday would
            // report the morning as a collapse, which is the kind of figure this page spends
            // its comments refusing to print.
            const comparable = !window.open && previous !== null;

            return {
                window,
                ...current,
                previous,
                deltaSales:
                    comparable && previous
                        ? deltaPercent(current.orders.sales, previous.orders.sales)
                        : null,
                deltaProfit:
                    comparable &&
                    previous &&
                    current.profit.netProfit !== null &&
                    previous.profit.netProfit !== null
                        ? deltaPercent(current.profit.netProfit, previous.profit.netProfit)
                        : null,
            };
        });
    });

    /**
     * Ozon's commission rate per article, and the spread across them.
     *
     * The account-wide rate is a blend, not a rate: in September it read 51 % while articles
     * ran from 17 % to 52 %, the blend being pulled up by two high-revenue suitcases. A
     * seller prices per article, so the per-article figure is the one that answers anything.
     */
    /**
     * Money that may be unknown.
     *
     * A null balance field is not zero: it means the method did not report it. Rendering
     * `0 ₽` there would invent a figure, so it renders a dash.
     */
    const moneyOrDash = (value: number | null | undefined): string =>
        value === null || value === undefined ? "—" : formatCurrency(value);

    // --- The month's realization, cost of goods, tax and what is left ---
    //
    // Both the data and the failure are attributed to the month they belong to by a tested
    // helper, so a stale answer can never appear under a newly selected month.
    const monthViewResult = $derived(
        monthView(
            periodMonth,
            requestedMonth,
            $monthFinanceData,
            $monthFinanceError as { status?: number; message?: string } | null,
        ),
    );
    const monthFinance = $derived(monthViewResult.data);
    const monthError = $derived(
        monthViewResult.error === null
            ? null
            : { ...monthViewResult.error, message: describeFailure(monthViewResult.error) },
    );
    // Ozon publishes the monthly report after the month closes, so the current month has
    // none. That is a state to explain, not an error to report.
    const monthReportMissing = $derived(monthViewResult.reportMissing);

    const monthRealization = $derived(monthFinance?.realization ?? null);
    const monthBalance = $derived(monthFinance?.balance ?? null);
    const monthCashflows = $derived(monthFinance?.cashflows ?? null);
    const monthPartialError = $derived(monthFinance?.partialError ?? null);

    /**
     * Cost of the goods sold in the selected month.
     *
     * Taken from the dated cost book at the end of that month, so an old month uses the
     * price that applied then. Units are net of returns, because a returned item comes back
     * into stock rather than being sold. Coverage is reported rather than assumed: a net
     * figure built on a partly known cost would be a guess wearing a precise number.
     */
    const monthCost = $derived.by(() => {
        const realization = monthRealization;
        if (!realization) return { cost: null as number | null, covered: 0, units: 0, complete: false };

        const bounds = monthBounds(periodMonth);
        const at = bounds ? new Date(`${bounds.to}T23:59:59`) : new Date();
        // The same helper the cards use for their closed month, so one definition of cost of
        // goods serves both and they cannot disagree about the same month.
        const totals = realizationCost(realization.perSku, at, costs);

        return {
            cost: totals.cogs,
            covered: totals.coveredUnits,
            units: totals.units,
            complete: totals.complete
        };
    });

    /**
     * What is left after tax and the cost of goods.
     *
     * The income and the taxable base are not always the same thing, which is why both are
     * named: under a `доходы` regime the rate is charged on money received, under a profit
     * regime on the margin. All three settings reduce to the tested calculation.
     */
    /**
     * What Ozon pays for each settlement period.
     *
     * A payout is the sum of the accruals dated inside its period — checked to the kopeck
     * against the cabinet's own payout report on every September period it covered:
     * 01–06.09 gives 26 729.31, 07–13.09 gives 33 367.38, and so on. The composition table
     * below is a different reading (the balance report's), which is why its total never
     * equalled the payout; this is the number the seller actually receives.
     */
    const payoutPeriodRows = $derived.by(() => {
        const periods = payoutPeriods(periodMonth).map((period) => ({
            ...period,
            payout: 0,
            days: 0,
        }));

        for (const day of accrualDays) {
            const index = periods.findIndex(
                (period) => day.date >= period.from && day.date <= period.to,
            );
            if (index === -1) continue;

            periods[index].payout += day.net;
            periods[index].days += 1;
        }

        return periods;
    });

    /** Days a period should contain, inclusive. */
    const daysInPeriod = (from: string, to: string): number =>
        Math.round(
            (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) /
                86400000,
        ) + 1;

    /** Payout for the period a week row belongs to, or `null` when the accruals do not cover it. */
    const payoutFor = (from: string): number | null => {
        const match = payoutPeriodRows.find((period) => period.from === from);
        // A period the accruals do not fully cover is not reported: a partial sum would read
        // as a short payout rather than as missing data.
        if (!match || match.days !== daysInPeriod(match.from, match.to)) return null;

        return match.payout;
    };

    /** True when every settlement period of the month is covered by loaded accruals. */
    const payoutCoverageComplete = $derived(
        payoutPeriodRows.length > 0 &&
            payoutPeriodRows.every(
                (period) => period.days === daysInPeriod(period.from, period.to),
            ),
    );

    /**
     * The settlement periods added up, and whether that equals what was accrued.
     *
     * It must: a payout is the accruals of its period, so the periods of a month are simply
     * that month's accruals cut into weeks. Showing the sum turns the claim into something
     * the reader can check on screen: the periods of any settled month add up to that month's
     * accrued total, to the kopeck.
     */
    const payoutPeriodsTotal = $derived.by(() => {
        const weeks = monthFinance?.weeks ?? [];
        let total = 0;
        let covered = 0;

        for (const week of weeks) {
            const value = payoutFor(week.from);
            if (value === null) continue;
            total += value;
            covered += 1;
        }

        const accrued = monthBalance?.accrued ?? null;

        return {
            total,
            covered,
            expected: weeks.length,
            complete: weeks.length > 0 && covered === weeks.length,
            accrued,
            matchesAccrued:
                accrued !== null && covered === weeks.length && Math.abs(total - accrued) < 0.02,
        };
    });

    /** What is left after tax and the cost of goods for the month. */
    const monthProfit = $derived.by(() => {
        const settings = $taxSettings;
        // The first step of the chain is always the money Ozon sends. The tax may be charged
        // on something larger — the realized revenue — which is why the two are separate.
        const payout = monthBalance?.accrued ?? 0;
        // Realized minus returns, which is the figure the seller declares: Ozon's «Реализовано»
        // is what buyers paid, and what came back to them is not income.
        const realized = monthRealization?.net ?? 0;
        const cost = monthCost.complete ? monthCost.cost : null;

        const taxable = taxableAmount(settings.base, { payout, realized, cost });
        const result = profitAfterTaxAndCost({
            payout,
            taxable,
            taxPercent: settings.percent,
            cost,
        });

        return {
            ...result,
            base: settings.base,
            /** False when the cost book cannot cover the month, so no net is shown. */
            costKnown: monthCost.complete,
            realized
        };
    });

    let showCogs = $state(false);

    /**
     * How far down the page the reader is, and whether the way back is worth offering.
     *
     * One passive listener for both: the ring is this number, so a second listener for the
     * button's visibility would measure the same thing twice. The handler is not throttled
     * because it only assigns state — the browser coalesces the paint, and a rAF wrapper
     * would add a frame of lag to a control that should feel immediate.
     */
    let scrollProgress = $state(0);
    let showToTop = $state(false);
    /**
     * Whether the strip along the top of the viewport should take taps.
     *
     * It stays inert while the header is still on screen: there the same strip would sit over
     * the refresh and settings buttons and swallow them, and there is nothing above to scroll
     * back to anyway. Past the header it is the only thing at the top of the viewport — which,
     * on a phone in standalone mode, is the region iOS would otherwise use for its own
     * tap-to-top gesture and does not.
     */
    let showTopStrip = $state(false);

    $effect(() => {
        const onScroll = () => {
            const scrolled = window.scrollY;
            const scrollable = document.documentElement.scrollHeight - window.innerHeight;

            scrollProgress = scrollable > 0 ? Math.min(1, Math.max(0, scrolled / scrollable)) : 0;
            showToTop = scrolled > 600;
            showTopStrip = scrolled > 140;
        };

        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);

        return () => {
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", onScroll);
        };
    });

    /** Honours a reduced-motion preference: a long smooth scroll is exactly the motion it asks to avoid. */
    function scrollToTop() {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    }



    // --- Capital and priorities ---
    const capital = $derived(
        capitalSummary({
            inventory,
            economics: skuRows,
            unitCost: (offerId, sku) => costs(offerId, sku, new Date()),
            // Turnover and GMROI divide by the period the figures cover, so the selected
            // period has to reach them too.
            periodDays: periodDayList.length
        })
    );



    /**
     * Products offered in the cost panel: the window's own, plus the month's.
     *
     * The loaded window is not enough on its own. Ozon's monthly realization report can
     * contain articles that sold outside that window — a product sold on 1 September is
     * already gone from a 31-day feed read in October — and if the panel cannot offer them,
     * their cost can never be entered, the month's coverage stays short of every unit, and
     * the net figure is withheld forever with no way to fix it. That is exactly what
     * happened: 8 units of 370 had nowhere to be priced.
     */
    const costCandidates = $derived(
        mergeCostCandidates(
            skuRows.map((row) => ({
                key: row.key,
                label: row.name,
                units: row.units,
                payout: row.payout,
            })),
            monthRealization?.perSku ?? [],
            costKey,
        ),
    );

    /** How many products the cost book knows about, regardless of the selected period. */
    const costBookSize = $derived(Object.keys($costBook).length);

    /** Month products whose sale has no cost price, so the reader knows what to fill in. */
    const monthMissingCosts = $derived.by(() => {
        const realization = monthRealization;
        if (!realization) return [];

        const bounds = monthBounds(periodMonth);
        const at = bounds ? new Date(`${bounds.to}T23:59:59`) : new Date();

        return realization.perSku
            .map((line) => ({
                label: line.name || line.offerId || String(line.sku),
                sold: Math.max(0, line.units - line.returnedUnits),
                known: costs(line.offerId, line.sku, at) !== undefined,
            }))
            .filter((line) => line.sold > 0 && !line.known)
            .sort((a, b) => b.sold - a.sold);
    });

    // Dynamic title for the browser tab, showing today's net sales once there are any.
    const pageTitle = $derived(
        stats.calendarDay.netSum > 0
            ? `${formatCurrency(stats.calendarDay.netSum)} сегодня | Ozon Dashboard`
            : "Ozon Seller Dashboard | Аналитика продаж",
    );

    // Pagination for orders
    let currentPage = $state(1);
    const itemsPerPage = 10;
    const totalPages = $derived(Math.ceil(postingsData.length / itemsPerPage));
    const sortedPostings = $derived(
        [...postingsData].sort(
            (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime(),
        ),
    );
    const paginatedPostings = $derived(
        sortedPostings.slice(
            (currentPage - 1) * itemsPerPage,
            currentPage * itemsPerPage,
        ),
    );

    // Money per posting line for the orders table. Computed once per page instead of
    // per cell, because the join walks every line of the posting.
    const rowMoneyByPosting = $derived(
        new Map(
            paginatedPostings.map((posting) => [
                posting.posting_number,
                enrichLines(posting),
            ]),
        ),
    );

    // A refresh can shrink the history, which would otherwise strand the reader on a
    // page that no longer exists — "Page 12 of 8" above an empty table.
    $effect(() => {
        const lastPage = Math.max(1, totalPages);
        if (currentPage > lastPage) currentPage = lastPage;
    });

    // Timestamp of the payload currently on screen, so the reader can tell whether
    // the figures are five seconds or five hours old.
    let lastUpdated = $state<Date | null>(null);
    $effect(() => {
        const payload = $dashboardData;
        if (payload) lastUpdated = new Date();
    });

</script>

<svelte:head>
    <title>{pageTitle}</title>
    <meta
        name="description"
        content="Дашборд продавца Ozon. Статистика заказов, аналитика продаж за 24 часа, 7 и 31 день."
    />
    <meta property="og:title" content="Ozon Seller Dashboard" />
    <meta
        property="og:description"
        content="Аналитика продаж и заказов для продавцов Ozon"
    />
</svelte:head>

<div class="dashboard">
    <OzonHeader
        title="Ozon Dashboard"
        titleHref="/"
        subtitle="Real-time business insights for Seller ID"
        navHref="/stocks"
        navLabel="View Stocks →"
        validating={$isValidating}
        error={error}
        onRefresh={() => mutate({ force: true })}
    />

    {#if error}
        <div class="error-card" role="alert">
            <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                stroke="currentColor"
                fill="none"
                stroke-width="2"
                aria-hidden="true"
                ><circle cx="12" cy="12" r="10" /><line
                    x1="12"
                    y1="8"
                    x2="12"
                    y2="12"
                /><line x1="12" y1="16" x2="12.01" y2="16" /></svg
            >
            <div class="error-text">
                <p>{error}</p>
                {#if showingStaleData}
                    <p class="error-note">
                        На экране данные, полученные ранее{lastUpdated
                            ? ` (в ${formatTime(lastUpdated)})`
                            : ""}: обновить их не удалось.
                    </p>
                {/if}
            </div>
            <button
                type="button"
                class="btn-retry"
                onclick={() => mutate({ force: true })}
                disabled={$isValidating}
            >
                {$isValidating ? "Обновляем…" : "Повторить"}
            </button>
        </div>
    {/if}

    {#if nothingToShow}
        <div class="panel glass-panel no-data">
            <p>Данные не загружены, поэтому показывать нечего.</p>
            <p class="muted-note">
                Исправьте доступы (шестерёнка справа сверху) или повторите загрузку
                кнопкой выше.
            </p>
        </div>
    {:else}

    <section class="stats-section" aria-busy={showSkeletons}>
        <div class="bento-header">
            <h2 class="section-title">Сейчас · четыре периода</h2>
            <InfoTip
                text="Четыре окна, привязанных к сегодняшнему дню, а не к переключателю периода ниже: сегодня (с 00:00), вчера, с начала календарного месяца и прошлый закрытый месяц. Sales — цена продавца без отменённых заказов, то есть деньги покупателя. Отмены и возвраты показаны отдельными строками и из Sales не вычтены: отмена — это заказ, который не состоялся, а возврат приходит своей датой и своими деньгами. Adv. cost — рекламные удержания Ozon из начислений (оплата за клик и соседние механики), они уже вычтены внутри Est. payout и второй раз из прибыли не вычитаются. Est. payout — сколько Ozon начислил за окно, то есть что дойдёт до счёта; Net profit — то же минус себестоимость проданного и налог по вашим настройкам (ставка и база берутся из них же). У каждой строки есть подсказка при наведении: из чего сложилась сумма, что в неё не вошло и откуда взяты данные. Для базы «от реализованного» налог считается по месячному отчёту Ozon: за прошлый месяц он есть, а за текущий, ещё не закрытый, его не существует — там прочерк, потому что цена заказов почти вдвое больше реализованного и налог по ней был бы завышен. Где начислений или себестоимости не хватает на всё окно, тоже прочерк: пустой ответ не показывается нулём."
                label="Пояснение к периодам"
            />
            <span class="updated-at" role="status" aria-live="polite">
                {#if showSkeletons}
                    загрузка данных…
                {:else if lastUpdated}
                    данные загружены в {formatTime(lastUpdated)}
                {:else}
                    нет данных
                {/if}
            </span>
        </div>

        <div class="period-grid">
            {#if showSkeletons}
                {#each [1, 2, 3, 4] as card (card)}
                    <div class="period-card glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-medium"></span>
                        <span class="skeleton sk-line"></span>
                    </div>
                {/each}
            {:else}
                {#each periodCards as card (card.window.key)}
                    {@const salesTip = tipRows(card, "sales")}
                    {@const ordersTip = tipRows(card, "orders")}
                    {@const cancelledTip = tipRows(card, "cancelled")}
                    {@const returnsTip = tipRows(card, "returns")}
                    {@const advTip = tipRows(card, "adv")}
                    {@const payoutTip = tipRows(card, "payout")}
                    {@const profitTip = tipRows(card, "profit")}
                    {@const salesNote = cardNote(card, "sales")}
                    {@const ordersNote = cardNote(card, "orders")}
                    {@const cancelledNote = cardNote(card, "cancelled")}
                    {@const returnsNote = cardNote(card, "returns")}
                    {@const advNote = cardNote(card, "adv")}
                    {@const payoutNote = cardNote(card, "payout")}
                    {@const profitNote = cardNote(card, "profit")}
                    <article class="period-card glass-panel tone-{card.window.key}">
                        <header class="period-card-head">
                            <span class="period-card-title">{card.window.label}</span>
                            <span class="period-card-range">{card.window.range}</span>
                        </header>

                        <div class="period-card-body">
                            <MetricTip
                                heading="Sales"
                                label="Как считается Sales"
                                note={salesNote}
                                title="Sales — цена продавца"
                                rows={salesTip.rows}
                                footer={salesTip.footer}
                                wide
                            >
                                <span class="metric-value metric-lead">
                                    {formatCurrencyParts(card.orders.sales).amount}<span class="unit"
                                        >₽</span
                                    >
                                    {#if card.deltaSales !== null}
                                        <span
                                            class="metric-delta"
                                            class:negative={card.deltaSales < 0}
                                            >{formatDelta(card.deltaSales)}{#if card.window.compare}<span
                                                    class="metric-delta-base"
                                                    >к {card.window.compare.short}</span
                                                >{/if}</span
                                        >
                                    {/if}
                                </span>
                            </MetricTip>

                            <MetricTip
                                heading="Orders / Units"
                                label="Как считаются заказы и штуки"
                                note={ordersNote}
                                title="Orders / Units"
                                rows={ordersTip.rows}
                                footer={ordersTip.footer}
                            >
                                <span class="metric-value"
                                    >{formatNumber(card.orders.orders)} /
                                    {formatNumber(card.orders.units)}</span
                                >
                            </MetricTip>

                            <MetricTip
                                heading="Отмены"
                                label="Как считаются отмены"
                                note={cancelledNote}
                                title="Отменённые заказы"
                                rows={cancelledTip.rows}
                                footer={cancelledTip.footer}
                            >
                                <span class="metric-value">
                                    {formatNumber(card.orders.cancelled)}
                                    {#if card.orders.cancelled > 0}
                                        <span class="metric-aside"
                                            >{formatCurrency(card.orders.cancelledSum)}</span
                                        >
                                    {/if}
                                </span>
                            </MetricTip>

                            <MetricTip
                                heading="Возвраты"
                                label="Как считаются возвраты"
                                note={returnsNote}
                                title="Возвраты покупателей"
                                rows={returnsTip.rows}
                                footer={returnsTip.footer}
                            >
                                <span class="metric-value">
                                    {formatNumber(card.returns.count)}
                                    {#if card.returns.count > 0}
                                        <span class="metric-aside"
                                            >{formatCurrency(card.returns.amount)}</span
                                        >
                                    {/if}
                                </span>
                            </MetricTip>

                            <MetricTip
                                heading="Adv. cost"
                                label="Из чего складывается расход на рекламу"
                                note={advNote}
                                title="Рекламные удержания Ozon"
                                rows={advTip.rows}
                                footer={advTip.footer}
                            >
                                <span class="metric-value">
                                    {#if card.accrual.complete}
                                        {formatCurrency(card.accrual.advertising)}
                                    {:else}
                                        <span class="metric-unknown">—</span>
                                    {/if}
                                </span>
                            </MetricTip>

                            <MetricTip
                                heading="Est. payout"
                                label="Из чего складывается начисление"
                                note={payoutNote}
                                title="Начислено Ozon за окно"
                                rows={payoutTip.rows}
                                footer={payoutTip.footer}
                            >
                                <span class="metric-value">
                                    {#if card.profit.payout !== null}
                                        {formatCurrency(card.profit.payout)}
                                    {:else}
                                        <span
                                            class="metric-unknown"
                                            title="Начисления за это окно ещё не пришли"
                                            >—</span
                                        >
                                    {/if}
                                </span>
                            </MetricTip>

                            <MetricTip
                                heading="Net profit"
                                label="Как считается чистая прибыль"
                                note={profitNote}
                                title="Что остаётся продавцу"
                                rows={profitTip.rows}
                                footer={profitTip.footer}
                            >
                                <span class="metric-value">
                                    {#if card.profit.netProfit !== null}
                                        {formatCurrency(card.profit.netProfit)}
                                        {#if card.deltaProfit !== null}
                                            <span
                                                class="metric-delta"
                                                class:negative={card.deltaProfit < 0}
                                                >{formatDelta(card.deltaProfit)}{#if card.window.compare}<span
                                                        class="metric-delta-base"
                                                        >к {card.window.compare.short}</span
                                                    >{/if}</span
                                            >
                                        {/if}
                                    {:else}
                                        <span
                                            class="metric-unknown"
                                            title={card.profit.taxable === null
                                                ? "Налог на реализованное берётся из месячного отчёта Ozon — за незакрытый месяц его ещё нет"
                                                : "Нет начислений или себестоимости на всё окно"}
                                            >—</span
                                        >
                                    {/if}
                                </span>
                            </MetricTip>
                        </div>
                    </article>
                {/each}
            {/if}
        </div>
    </section>

    <section class="details-section">
        <!--
            No panel around this one. Every other section is a heading over its content, and a
            boxed list read as a different kind of thing while its border and its 40 px of
            padding were most of the empty space the cards were showing.
        -->
        <div class="bento-header">
            <h2 class="section-title">Заказы FBO</h2>
            <InfoTip
                text="Десять последних заказов окна, по карточке на отправление. Цена — цена продавца, то есть деньги покупателя; стрелка показывает, сколько из неё остаётся продавцу после комиссии Ozon. Логистика, эквайринг и реклама сюда не входят: они приходят начислениями, и их видно в карточках «Сейчас» и в разделе «Месяц · деньги». Маршрут подсвечен, когда отправление едет между кластерами — по таким логистика дороже. Теги — механики Ozon, действовавшие на заказ."
                label="Пояснение к списку заказов"
            />
            {#if paginatedPostings.length > 0}
                <span class="section-note">
                    {paginatedPostings.length} из {postingsData.length} заказов окна
                </span>
            {/if}
            <div class="pagination">
                <button
                    class="btn-page"
                    disabled={currentPage === 1}
                    onclick={() => currentPage--}>Prev</button
                >
                <span class="page-info">Page {currentPage} of {totalPages || 1}</span>
                <button
                    class="btn-page"
                    disabled={currentPage >= totalPages}
                    onclick={() => currentPage++}>Next</button
                >
            </div>
        </div>
        <div class="order-list">
            {#if $isLoading}
                {#each Array(5) as _, index (index)}
                    <div class="order-card skeleton-card">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-line short"></span>
                    </div>
                {/each}
            {:else if paginatedPostings.length > 0}
                {#each paginatedPostings as posting (posting.posting_number)}
                    {@const rowMoney = rowMoneyByPosting.get(posting.posting_number)}
                    <article class="order-card">
                        <!--
                            One header line, not two stacked blocks. The date, the status,
                            payment and the route are four facts about the same order, and
                            as separate rows they cost a third of the card's height while
                            leaving most of its width empty.
                        -->
                        <header class="order-head">
                            <span class="order-date">
                                {new Date(posting.created_at).toLocaleString("ru-RU", {
                                    day: "2-digit",
                                    month: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                })}
                            </span>
                            <span class="status-pill" data-status={posting.status}
                                >{posting.status}</span
                            >
                            <span class="order-facts">
                                <span class="fact">
                                    <span class="fact-label">Оплата</span>
                                    {posting.analytics_data?.payment_type_group_name || "—"}
                                </span>
                                <span class="fact">
                                    <span class="fact-label">Маршрут</span>
                                    <span
                                        class="route-info"
                                        class:is-cross-cluster={posting.financial_data
                                            ?.cluster_from !==
                                            posting.financial_data?.cluster_to}
                                    >
                                        <span
                                            >{posting.financial_data?.cluster_from ||
                                                "—"}</span
                                        >
                                        <span class="arrow-icon">→</span>
                                        <span
                                            >{posting.financial_data?.cluster_to || "—"}
                                            <small class="meta-city"
                                                >({posting.analytics_data?.city ||
                                                    "—"})</small
                                            ></span
                                        >
                                    </span>
                                </span>
                            </span>
                        </header>

                        <ul class="order-lines">
                            {#each posting.products as product, i (`${product.sku || product.name}-${i}`)}
                                <li class="order-line">
                                    <div class="product-image-container small">
                                        {#if $dashboardData?.skuToImage?.[product.sku]}
                                            <img
                                                src={$dashboardData.skuToImage[product.sku]}
                                                alt={product.name}
                                                class="product-thumb"
                                                width="40"
                                                height="40"
                                                loading="lazy"
                                                decoding="async"
                                            />
                                        {:else}
                                            <div class="product-thumb-placeholder">
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    width="14"
                                                    height="14"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                    ><rect
                                                        x="3"
                                                        y="3"
                                                        width="18"
                                                        height="18"
                                                        rx="2"
                                                        ry="2"
                                                    /><circle
                                                        cx="8.5"
                                                        cy="8.5"
                                                        r="1.5"
                                                    /><polyline points="21 15 16 10 5 21" /></svg
                                                >
                                            </div>
                                        {/if}
                                    </div>

                                    <div class="line-body">
                                        <!--
                                            The article on the left, its money on the right
                                            of the same line: two lines per product instead
                                            of four, which is what the card spent its height
                                            on.
                                        -->
                                        <div class="line-top">
                                            <a
                                                href="/stocks?highlight={product.sku}"
                                                class="product-link"
                                            >
                                                {product.name}
                                            </a>
                                            {#if rowMoney?.[i]?.payout != null}
                                                <span class="line-money">
                                                    <span class="money-gross"
                                                        >{formatCurrency(rowMoney[i].gross)}</span
                                                    >
                                                    <span class="money-arrow" aria-hidden="true"
                                                        >→</span
                                                    >
                                                    <span class="money-net"
                                                        >{formatCurrency(
                                                            rowMoney[i].payout ?? 0,
                                                        )}</span
                                                    >
                                                </span>
                                            {:else}
                                                <span class="line-money">
                                                    <span class="money-net"
                                                        >{formatCurrency(
                                                            productUnitPrice(product) *
                                                                (product.quantity || 1),
                                                        )}</span
                                                    >
                                                </span>
                                            {/if}
                                        </div>
                                        <div class="line-sub">
                                            <span>SKU {product.sku}</span>
                                            {#if rowMoney?.[i]?.payout != null}
                                                <span class="line-dot" aria-hidden="true">·</span>
                                                <span
                                                    >комиссия
                                                    {formatCurrency(
                                                        rowMoney[i].commission ?? 0,
                                                    )}{rowMoney[i].commissionPercent != null
                                                        ? ` · ${formatPercent(rowMoney[i].commissionPercent ?? 0)}`
                                                        : ""}</span
                                                >
                                            {:else}
                                                <span class="line-dot" aria-hidden="true">·</span>
                                                <span>Ozon не отдал суммы по этой строке</span>
                                            {/if}
                                        </div>
                                    </div>
                                </li>
                            {/each}
                        </ul>

                        <!-- Pills only: the label above them said what they already say. -->
                        <div class="order-tags">
                            {#if posting.actions.length > 0}
                                {#each posting.actions as action}
                                    <span class="action-tag">{action}</span>
                                {/each}
                            {:else}
                                <span class="no-actions">без тегов</span>
                            {/if}
                        </div>
                    </article>
                {/each}
            {:else}
                <div class="order-empty">За этот период заказов нет.</div>
            {/if}
        </div>
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Склад · остатки по товарам</h2>
            <InfoTip
                text="Сопоставление продаж за 14 дней с текущими остатками. «Продаж/день» — средний спрос в штуках, «Хватит на» — на сколько дней хватит склада при этом темпе (запас в днях). «Запас в закупке» — это оборотный капитал по вашей себестоимости, а не по цене продажи; рядом для сравнения та же полка в ценах продажи. «Оборачиваемость» и запас в днях считаются от текущей стоимости запаса, потому что истории остатков мы пока не храним: при ровном складе это близко к среднему."
                label="Пояснение к остаткам и оборачиваемости"
            />
        </div>

        {#if stocksLoadingNow}
            <div class="kpi-strip" aria-hidden="true">
                {#each [1, 2, 3, 4, 5] as chip (chip)}
                    <div class="kpi-chip glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-chip"></span>
                    </div>
                {/each}
            </div>
        {:else if stocksFailed}
            <div class="panel glass-panel state-note" role="alert">
                <p>Остатки загрузить не удалось: {stocksLoadError}</p>
                <button
                    type="button"
                    class="btn-retry"
                    onclick={() => mutateStocks({ force: true })}
                >
                    Повторить
                </button>
            </div>
        {:else if stocksEmpty}
            <div class="panel glass-panel state-note">
                <p>Остатков нет: Ozon не вернул ни одной строки FBO.</p>
            </div>
        {:else}
            <div class="kpi-strip">
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">На складе, шт</span>
                    <span class="kpi-value">{formatNumber(inventory.totalPresent)}</span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">В резерве, шт</span>
                    <span class="kpi-value">{formatNumber(inventory.totalReserved)}</span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Стоимость остатков</span>
                    <span class="kpi-value">{formatCurrency(inventory.inventoryValue)}</span>
                </div>
                <!--
                    Moved here from the capital section: they describe the same stock the table
                    below lists, and a reader who wants to know what is lying in the warehouse
                    should not have to look in two places for its cost and its speed.
                -->
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Запас в закупке</span>
                    <span class="kpi-value"
                        >{capital.stockAtCost === null
                            ? "—"
                            : formatCurrency(capital.stockAtCost)}</span
                    >
                    <span class="kpi-delta"
                        >в ценах продажи
                        {formatCurrency(capital.stockAtRetail)}
                        {capital.costedShare < 1
                            ? ` · себестоимость известна для ${formatPercent(capital.costedShare * 100, 0)} запаса`
                            : ""}</span
                    >
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Оборачиваемость</span>
                    <span class="kpi-value"
                        >{capital.turnoverRatio === null
                            ? "—"
                            : `${capital.turnoverRatio.toFixed(2).replace(".", ",")}×`}</span
                    >
                    <span class="kpi-delta"
                        >{capital.daysOfStock === null
                            ? "нужна полная себестоимость"
                            : `запас на ${Math.round(capital.daysOfStock)} дн.`}</span
                    >
                </div>
            </div>
        {/if}
    </section>

    {#if periodIsPartial}
        <div class="panel glass-panel state-note" role="status">
            <p>
                Загружена история заказов только с {loadedFromDay}, поэтому за {periodLabel}
                {periodHasNoOrders
                    ? "заказов в загруженном окне нет вовсе — а не «продаж не было»"
                    : "данные неполные, суммы занижены"}.
            </p>
            <p class="muted-note">
                Месячные документы Ozon при этом полные: раздел «Месяц · деньги: от реализации
                до счёта» считает по ним, а не по загруженным заказам, поэтому цепочка от
                реализации до счёта за такой период остаётся верной. Разрезы продаж и таблица
                заказов ниже строятся по заказам, поэтому за такой период они недоступны.
            </p>
            <!--
                What was asked for against what arrived. The window is derived from the month
                on screen, so these two lines together say whether the short history is the
                request's doing or the payload's — the question this notice kept raising
                without answering.
            -->
            <p class="muted-note">
                Запрошено окно {formatDay(dashboardWindowFrom)}{dashboardWindowTo
                    ? ` — ${formatDay(dashboardWindowTo)}`
                    : " — по сегодня"}
                · первый заказ в данных {formatDay(loadedFromDay)}
            </p>
            <!--
                The window asked for always starts at the first day of the month on screen, so
                this notice means the payload on screen is older than the request rather than
                that the month is out of reach. Dropping the cache and asking again is the
                remedy, so it is offered here instead of being left to the reader to guess.
            -->
            <button
                type="button"
                class="btn-inline"
                onclick={() => {
                    resetDashboard();
                    void mutate({ force: true });
                }}
                disabled={$isValidating}
            >
                {$isValidating ? "Загружаем…" : `Загрузить ${periodLabel} полностью`}
            </button>
        </div>
    {/if}


    <section class="insights-section" aria-label="Месяц: реализация, налоги и себестоимость">
        <div class="bento-header">
            <h2 class="section-title">Месяц · деньги: от реализации до счёта</h2>
            <InfoTip
                text="Здесь месяц читается по месячным документам Ozon, а не по ленте заказов, поэтому доступны и месяцы старше загруженного окна. «Реализовано» в отчёте Ozon — это НЕ цена продавца, а то, что заплатил покупатель: цена продавца собирается из трёх частей, и проверено на строке отчёта — 642,86 оплатил покупатель + 571,71 доплатил Ozon за свою скидку + 6,43 партнёр = 1221,00, ровно выставленная цена. Поэтому в цепочке ниже «Оплачено покупателями» — только первая из трёх частей, а цена продавца — их сумма. «Возвращено» — сумма возвратов клиентов, «Выплаты по механикам» — то, что доплачивают партнёры по программам лояльности. «Начислено» и «Выплачено» — из отчёта о балансе: первое это сколько Ozon насчитал за период, второе — сколько реально перевёл. Ниже из денег вычитаются налог (по умолчанию от реализованного за вычетом возвратов) и себестоимость — в этом порядке."
                label="Пояснение к месячному разделу"
            />
            <!--
                The month control lives in the section it drives. It used to sit in a bar of its
                own above every money section, which read as a page-level filter — while the
                cards at the top of the page deliberately ignore it, being anchored to today.
                The cost book moved here with it: the chain below is what needs a cost price, so
                this is where a reader notices that one is missing.
            -->
            <div class="period-inline">
                <span class="period-title">Месяц отчёта</span>
                <PeriodPicker bind:month={periodMonth} months={availableMonthList} />
                <button type="button" class="btn-inline" onclick={() => (showCogs = true)}>
                    {monthCost.units > 0
                        ? `Себестоимость (${monthCost.covered}/${monthCost.units} шт)`
                        : `Себестоимость · в справочнике ${costBookSize}`}
                </button>
            </div>
        </div>

        {#if $monthFinanceLoading && !monthRealization}
            <div class="kpi-strip">
                {#each Array(4) as _, index (index)}
                    <div class="kpi-chip glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-chip"></span>
                    </div>
                {/each}
            </div>
        {:else if monthReportMissing}
            <div class="panel glass-panel state-note">
                <p>
                    Отчёт о реализации за {monthLabel(periodMonth)} ещё не сформирован Ozon.
                    Он появляется после закрытия месяца, поэтому за текущий месяц его нет —
                    это не ошибка.
                </p>
                <p class="muted-note">
                    Начисления и деньги за этот месяц при этом доступны ниже: они приходят из
                    отчёта о балансе и из начислений по дням, а не из отчёта о реализации.
                </p>
            </div>
        {:else if monthError}
            <div class="panel glass-panel state-note" role="alert">
                <p>Не удалось загрузить {monthLabel(periodMonth)}: {monthError.message}</p>
                <button
                    type="button"
                    class="btn-inline"
                    onclick={() => mutateMonthFinance({ force: true })}
                    disabled={$monthFinanceValidating}
                >
                    {$monthFinanceValidating ? "Обновляем…" : "Повторить"}
                </button>
            </div>
        {:else if monthRealization && monthRealization.rows === 0}
            <div class="panel glass-panel state-note">
                <p>
                    За {monthLabel(periodMonth)} в отчёте о реализации нет строк: продаж не
                    было, либо отчёт ещё пуст.
                </p>
            </div>
        {:else if monthRealization}
            <div class="kpi-strip">
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Оплачено покупателями · {monthLabel(periodMonth)}</span>
                    <span class="kpi-value">{formatCurrency(monthRealization.realized)}</span>
                    <span class="kpi-delta">
                        «Реализовано» в отчёте Ozon: {monthRealization.units} шт · {monthRealization.rows} строк
                    </span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Возвращено</span>
                    <span class="kpi-value">{formatCurrency(monthRealization.returned)}</span>
                    <span class="kpi-delta">{monthRealization.returnedUnits} шт вернули</span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Осталось оплаченным</span>
                    <span class="kpi-value">{formatCurrency(monthRealization.net)}</span>
                    <span class="kpi-delta">
                        за вычетом возвратов; это ещё не выручка продавца, а деньги покупателей
                    </span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Выплаты по механикам</span>
                    <span class="kpi-value">{formatCurrency(monthRealization.loyaltyNet)}</span>
                    <span class="kpi-delta">доплаты партнёров за период</span>
                </div>
            </div>

            <div class="panel glass-panel payout-panel">
                <div class="panel-head">
                    <span class="panel-title-group">
                        <h3 class="panel-title">Деньги по отчёту о балансе</h3>
                        <InfoTip
                            text="Кошелёк на счёте Ozon. «Остаток на начало» — сколько уже лежало на счёте в первый день месяца, «остаток на конец» — сколько лежит в последний. Связь между четырьмя числами одна: остаток на начало + начислено − выплачено = остаток на конец, и на проверенном месяце это сходится до копейки. «Начислено» — сколько Ozon насчитал за месяц: сумма сверена с итогом начислений по дням, две независимые ветки API сходятся. «Выплачено» — сколько Ozon перевёл за месяц, и оно больше начисленного ЗА ЭТОТ месяц законно: переводили за прошлые периоды. Проверено по отчёту кабинета о выплатах: перечисленное за месяц сходится с дашбордом после вычета «оплаты выкупов маркетплейсом», которую баланс в «выплачено» не включает. Поэтому начисленное за месяц на счёт ещё не пришло: оно придёт в следующих периодах, и это видно как остаток на конец. Статусы и плановые даты отдельных выплат этот метод не отдаёт: в кабинете они есть, в API я их не нашёл."
                            label="Пояснение к балансу"
                        />
                    </span>
                </div>

                {#if monthBalance}
                    <div class="payout-grid">
                        <div class="payout-cell">
                            <span class="payout-label">Начислено за месяц</span>
                            <span class="payout-value">{moneyOrDash(monthBalance.accrued)}</span>
                            {#if monthBalance.accrued !== null && previousFinance.net !== 0 && financeDeltaPct !== null}
                                <span class="payout-note">
                                    {previousLabel}: {formatCurrency(previousFinance.net)} ·
                                    <span
                                        class:positive={financeDeltaPct >= 0}
                                        class:negative={financeDeltaPct < 0}
                                        >{formatDelta(financeDeltaPct)}</span
                                    >
                                </span>
                            {/if}
                        </div>
                        <div class="payout-cell">
                            <span class="payout-label">Выплачено за месяц</span>
                            <span class="payout-value">{moneyOrDash(monthBalance.paid)}</span>
                        </div>
                        <div class="payout-cell">
                            <span class="payout-label">Остаток на начало</span>
                            <span class="payout-value">{moneyOrDash(monthBalance.opening)}</span>
                        </div>
                        <div class="payout-cell">
                            <span class="payout-label">Остаток на конец</span>
                            <span class="payout-value">{moneyOrDash(monthBalance.closing)}</span>
                        </div>
                    </div>
                {:else}
                    <p class="muted-note">
                        Баланс за этот месяц недоступен{monthPartialError
                            ? `: ${monthPartialError}`
                            : ""}.
                    </p>
                {/if}

                {#if monthCashflows}
                    <h4 class="panel-subtitle">От реализованного до счёта</h4>
                    <p class="muted-note breakdown-note">
                        Цепочка сверху вниз, по датам начисления. Она начинается с
                        реализованного, а не с суммы по карточкам заказов: карточки считаются
                        по дате создания заказа и потому описывают другой набор заказов —
                        свести их в одну строку нельзя, и это не ошибка. Комиссия Ozon здесь
                        отдельной строкой: в отчёте о реализации она всегда ноль, а в
                        начислениях спрятана внутри итога.
                    </p>
                    <div class="week-table" role="table" aria-label="Разбор начислений">
                        <div class="week-row breakdown-row breakdown-head" role="row">
                            <span role="columnheader">Статья</span>
                            <span role="columnheader">Сумма</span>
                            <span role="columnheader">Из чего</span>
                        </div>
                        <div class="week-row breakdown-row" role="row">
                            <span role="cell">Оплачено покупателями</span>
                            <span role="cell">{formatCurrency(monthCashflows.sales.revenue)}</span>
                            <span role="cell" class="breakdown-detail" data-label="Из чего">
                                это «Реализовано» в отчёте Ozon — покупатель платит меньше твоей
                                цены
                            </span>
                        </div>
                        <div class="week-row breakdown-row" role="row">
                            <span role="cell">+ Доплата Ozon за скидки</span>
                            <span role="cell">{formatCurrency(monthCashflows.sales.points)}</span>
                            <span role="cell" class="breakdown-detail">
                                скидку, которую дал Ozon, он же и доплачивает — в отчёте это
                                «баллы за скидки»
                            </span>
                        </div>
                        <div class="week-row breakdown-row" role="row">
                            <span role="cell">+ Программы партнёров</span>
                            <span role="cell"
                                >{formatCurrency(monthCashflows.sales.partnerPrograms)}</span
                            >
                            <span role="cell" class="breakdown-detail">
                                доплаты банков и партнёров по механикам лояльности
                            </span>
                        </div>
                        <div class="week-row breakdown-row" role="row">
                            <span role="cell">= Цена продавца по проданному</span>
                            <span role="cell">{formatCurrency(monthCashflows.sales.amount)}</span>
                            <span role="cell" class="breakdown-detail">
                                сумма, которую вы выставляли: проверено на строке отчёта —
                                642,86 + 571,71 + 6,43 = 1221,00
                            </span>
                        </div>
                        <div class="week-row breakdown-row" role="row">
                            <span role="cell" class="negative">Комиссия Ozon</span>
                            <span role="cell" class="negative"
                                >{formatCurrency(monthCashflows.sales.fee)}</span
                            >
                            <span role="cell" class="breakdown-detail">
                                {monthCashflows.sales.amount !== 0
                                    ? `${formatPercent(Math.abs(monthCashflows.sales.fee / monthCashflows.sales.amount) * 100)} от продаж`
                                    : "—"}
                            </span>
                        </div>
                        <div class="week-row breakdown-row" role="row">
                            <span role="cell" class="negative">Возвраты</span>
                            <span role="cell" class="negative"
                                >{formatCurrency(monthCashflows.returns.amount)}</span
                            >
                            <span role="cell" class="breakdown-detail">
                                выручка {formatCurrency(monthCashflows.returns.revenue)} · баллы
                                {formatCurrency(monthCashflows.returns.points)}
                            </span>
                        </div>
                        <div class="week-row breakdown-row" role="row">
                            <span role="cell">Сборы по возвратам</span>
                            <span role="cell">{formatCurrency(monthCashflows.returns.fee)}</span>
                            <span role="cell" class="breakdown-detail">начислено в плюс</span>
                        </div>
                        {#each monthCashflows.services as service (service.name)}
                            <div class="week-row breakdown-row" role="row">
                                <span role="cell" class="negative">{serviceLabel(service.name)}</span>
                                <span role="cell" class="negative"
                                    >{formatCurrency(service.amount)}</span
                                >
                                <span role="cell" class="breakdown-detail">услуга</span>
                            </div>
                        {/each}
                        <div class="week-row breakdown-row breakdown-total" role="row">
                            <span role="cell">Итого начислено</span>
                            <span role="cell">{formatCurrency(monthCashflows.total)}</span>
                            <span role="cell" class="breakdown-detail">
                                сходится с суммой начислений по дням
                            </span>
                        </div>
                    </div>
                {/if}

                {#if (monthFinance?.weeks ?? []).length > 0}
                    <h4 class="panel-subtitle">К выплате по периодам</h4>
                    <p class="muted-note breakdown-note">
                        Сумма начислений за период — именно её Ozon перечисляет. Сверено с
                        отчётом кабинета о выплатах: суммы по периодам совпали до копейки.
                        Заказы, возвраты и комиссия — из отчёта о балансе; его поля «услуги» я
                        свести не смог (в одном периоде там положительная сумма, несовместимая
                        с фактическими расходами), поэтому состава услуг здесь нет, а
                        проверенный состав месяца — в блоке выше.
                        {#if !payoutCoverageComplete}
                            Часть периодов ещё не покрыта загруженными начислениями, поэтому
                            «К выплате» местами пусто.
                        {/if}
                    </p>
                    <div class="week-table" role="table" aria-label="Периоды выплат">
                        <div class="week-row week-head" role="row">
                            <span role="columnheader">Период</span>
                            <span role="columnheader">Заказы</span>
                            <span role="columnheader">Возвраты</span>
                            <span role="columnheader">Комиссия</span>
                            <span role="columnheader">К выплате</span>
                        </div>
                        {#each monthFinance?.weeks ?? [] as week (`${week.from}-${week.to}`)}
                            <div class="week-row" role="row">
                                <span role="cell" class="week-dates">
                                    {week.from.slice(8, 10)}.{week.from.slice(5, 7)}–{week.to.slice(8, 10)}.{week.to.slice(5, 7)}
                                </span>
                                <span role="cell" data-label="Заказы"
                                    >{formatCurrency(week.orders)}</span
                                >
                                <span role="cell" class="negative" data-label="Возвраты"
                                    >{formatCurrency(week.returns)}</span
                                >
                                <span role="cell" class="negative" data-label="Комиссия"
                                    >{formatCurrency(week.commission)}</span
                                >
                                <span role="cell" class="week-net" data-label="К выплате">
                                    {moneyOrDash(payoutFor(week.from))}
                                </span>
                            </div>
                        {/each}
                        {#if payoutPeriodsTotal.complete}
                            <div class="week-row breakdown-total" role="row">
                                <span role="cell" data-label="Итого по периодам"
                                    >Итого по периодам</span
                                >
                                <span role="cell"></span>
                                <span role="cell"></span>
                                <span role="cell"></span>
                                <span role="cell" class="week-net" data-label="Итого">
                                    {formatCurrency(payoutPeriodsTotal.total)}
                                </span>
                            </div>
                        {/if}
                    </div>

                    {#if payoutPeriodsTotal.complete}
                        <p class="muted-note breakdown-note">
                            {#if payoutPeriodsTotal.matchesAccrued}
                                Сумма по периодам равна «Начислено за месяц»
                                {formatCurrency(payoutPeriodsTotal.accrued ?? 0)} — это одна и та
                                же величина: выплаты складываются из начислений, просто месяц
                                режется на недели. Выплачивают их позже: указанные даты —
                                плановые, а не фактические.
                            {:else}
                                Сумма по периодам {formatCurrency(payoutPeriodsTotal.total)} не
                                равна «Начислено за месяц»
                                {formatCurrency(payoutPeriodsTotal.accrued ?? 0)} — расхождение
                                {formatCurrency(
                                    payoutPeriodsTotal.total -
                                        (payoutPeriodsTotal.accrued ?? 0),
                                )}. Это стоит разобрать, а не списать на округление.
                            {/if}
                        </p>
                    {/if}
                {/if}

                {#if !$financeLoading && finance.failedDays.length > 0}
                    <p class="muted-note" role="status">
                        Начисления за {finance.failedDays.length}
                        {finance.failedDays.length === 1 ? "день" : "дней"} не загрузились:
                        {finance.failedDays
                            .slice(0, 3)
                            .map((day) => day.date)
                            .join(", ")}{finance.failedDays.length > 3
                            ? ` и ещё ${finance.failedDays.length - 3}`
                            : ""}, поэтому суммы выше могут быть занижены — это не отсутствие
                        начислений, а сбой загрузки.
                    </p>
                {/if}

                {#if inTransit.orders > 0 && inTransit.expectedPayout !== null}
                    <p class="muted-note">
                        Ещё не начислено {formatCurrency(inTransit.expectedPayout)} — по
                        {inTransit.orders} доставленным
                        {inTransit.orders === 1 ? "заказу" : "заказам"} за
                        {inTransit.windowDays} дн. начисления ещё не пришли. Сумма посчитана по
                        карточкам заказов, а не Ozon, поэтому это оценка: сколько придёт, станет
                        известно после расчёта.
                    </p>
                {/if}
            </div>

            <div class="panel glass-panel tax-panel">
                <div class="panel-head">
                    <span class="panel-title-group">
                        <h3 class="panel-title">Налог и себестоимость</h3>
                        <InfoTip
                            text="Порядок расчёта: деньги, полученные от Ozon, минус налог, минус себестоимость проданных товаров. По умолчанию налог 7 % считается ОТ РЕАЛИЗОВАННОГО ЗА ВЫЧЕТОМ ВОЗВРАТОВ: то есть с «Реализовано» из отчёта минус возвраты. Это не перевод от Ozon, потому что Ozon удерживает комиссию и услуги, и не полная цена продавца: «Реализовано» в отчёте — то, что заплатили покупатели, без доплат Ozon за скидки и партнёрских, хотя эти доплаты приходят вам деньгами. Поэтому итог может выйти маленьким или отрицательным — это не ошибка расчёта, а следствие того, что налог считается с выручки. База переключается ниже: «от денег, полученных от Ozon» даст меньший налог, «от прибыли» — налог с выручки за вычетом себестоимости. Себестоимость берётся из вашего справочника и только за проданные штуки, без возвращённых; если цена известна не для всех товаров месяца, итог не показывается, потому что иначе получилось бы точное на вид число из неполных данных."
                            label="Пояснение к налогу и себестоимости"
                        />
                    </span>
                </div>

                <div class="tax-controls">
                    <label class="tax-field">
                        <span>Ставка, %</span>
                        <input
                            type="number"
                            min="0"
                            max="60"
                            step="0.1"
                            value={$taxSettings.percent}
                            onchange={(event) =>
                                taxSettings.setPercent(
                                    Number((event.currentTarget as HTMLInputElement).value),
                                )}
                        />
                    </label>
                    <label class="tax-field">
                        <span>База налога</span>
                        <select
                            value={$taxSettings.base}
                            onchange={(event) =>
                                taxSettings.setBase(
                                    (event.currentTarget as HTMLSelectElement).value as TaxBase,
                                )}
                        >
                            {#each Object.entries(TAX_BASE_LABELS) as [value, label] (value)}
                                <option {value}>{label}</option>
                            {/each}
                        </select>
                    </label>
                </div>

                {#if monthCost.units === 0}
                    <p class="muted-note">
                        За {monthLabel(periodMonth)} нет проданных штук, считать нечего.
                    </p>
                {:else}
                    <div class="tax-chain">
                        <div class="chain-step">
                            <span class="chain-label">Деньги от Ozon</span>
                            <span class="chain-value">{formatCurrency(monthProfit.payout)}</span>
                            <span class="chain-note">начислено за месяц</span>
                        </div>
                        <span class="chain-arrow" aria-hidden="true">−</span>
                        <div class="chain-step">
                            <span class="chain-label">Налог {$taxSettings.percent} %</span>
                            <span class="chain-value">{formatCurrency(monthProfit.tax)}</span>
                            <span class="chain-note">
                                {TAX_BASE_LABELS[monthProfit.base]}:
                                {formatCurrency(monthProfit.taxable)}
                            </span>
                        </div>
                        <span class="chain-arrow" aria-hidden="true">−</span>
                        <div class="chain-step">
                            <span class="chain-label">Себестоимость проданного</span>
                            <span class="chain-value">{moneyOrDash(monthCost.cost)}</span>
                            <span class="chain-note">
                                {monthCost.covered} из {monthCost.units} шт с известной ценой
                            </span>
                        </div>
                        <span class="chain-arrow" aria-hidden="true">=</span>
                        <div class="chain-step chain-result">
                            <span class="chain-label">Остаётся вам</span>
                            {#if monthProfit.net !== null}
                                <span
                                    class="chain-value"
                                    class:positive={monthProfit.net >= 0}
                                    class:negative={monthProfit.net < 0}
                                    >{formatCurrency(monthProfit.net)}</span
                                >
                                <span class="chain-note">
                                    {monthProfit.netPercent === null
                                        ? "—"
                                        : `${formatPercent(monthProfit.netPercent)} от денег`}
                                </span>
                            {:else}
                                <span class="chain-value">—</span>
                                <span class="chain-note">
                                    нужна цена всех проданных штук: есть {monthCost.covered} из {monthCost.units}
                                </span>
                            {/if}
                        </div>
                    </div>

                    {#if !monthCost.complete}
                        <p class="muted-note">
                            Итог скрыт намеренно: без цены на {monthCost.units -
                                monthCost.covered} шт любая сумма была бы догадкой.
                            {#if monthMissingCosts.length > 0}
                                Не хватает цены:
                                {monthMissingCosts
                                    .slice(0, 4)
                                    .map((line) => `${line.label} (${line.sold} шт)`)
                                    .join(", ")}{monthMissingCosts.length > 4
                                    ? ` и ещё ${monthMissingCosts.length - 4}`
                                    : ""}.
                            {/if}
                            Заполните себестоимость кнопкой «Себестоимость» в заголовке этого
                            раздела: товары из месячного отчёта в ней тоже есть.
                        </p>
                    {/if}
                {/if}
            </div>
        {/if}
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Месяц · структура продаж</h2>
            <InfoTip
                text="Разбивка продаж за выбранный месяц по разным срезам. Во всех разрезах отменённые заказы не учитываются. Период задаётся выбором месяца в разделе «Деньги: от реализации до счёта» и общий для всех панелей раздела."
                label="Пояснение к разрезам продаж"
            />
        </div>

        <!--
            Both charts follow the selected month, so they share a row on a wide screen: at
            full width a thirty-bar chart on a 1600 px container draws bars 45 px wide, which
            reads as a bar chart of nothing in particular. Half the width halves the bars.
        -->
        <div class="charts-row">
            <div class="panel glass-panel trend-panel">
                <div class="panel-head">
                    <span class="panel-title-group">
                        <h3 class="panel-title">Тренд выручки продавца · {periodLabel}</h3>
                        <InfoTip
                            text="Цена продавца по дням за выбранный период (без отменённых заказов) — это деньги покупателя, а не поступление на счёт. Период задаётся выбором месяца в разделе «Деньги: от реализации до счёта» и общий для всех разделов, включая график по часам."
                            label="Пояснение к тренду выручки"
                        />
                    </span>
                    <div class="panel-controls">
                        <span class="panel-note">максимум {formatCurrency(trendMax)} в день</span>
                    </div>
                </div>
                {#if showSkeletons}
                    <div class="sk-chart" aria-hidden="true"></div>
                {:else}
                    <div class="trend-chart">
                        {#each trend as point (point.date)}
                            <div
                                class="trend-bar-wrap"
                                title="{point.date}: {formatCurrency(point.netRevenue)} · {point.orders} заказов"
                            >
                                <div
                                    class="trend-bar"
                                    class:is-empty={point.netRevenue <= 0}
                                    style="height: {Math.max(2, Math.round((point.netRevenue / trendMax) * 100))}%"
                                ></div>
                            </div>
                        {/each}
                    </div>
                    <div class="trend-axis">
                        <span>{trend[0]?.date ?? ""}</span>
                        <span>{trend.at(-1)?.date ?? ""}</span>
                    </div>
                {/if}
            </div>

            <div class="panel glass-panel hour-panel">
            <div class="panel-head">
                <span class="panel-title-group">
                    <h3 class="panel-title">Когда покупают · по часам ({periodLabel})</h3>
                    <InfoTip
                        text="Распределение заказов по часам суток за выбранный период (местное время). Период общий для всей страницы. Самый активный час выделен золотым."
                        label="Пояснение к разрезу по часам"
                    />
                </span>
                <div class="panel-controls">
                    <span class="panel-note">
                        пик {pad(peakHour.hour)}:00–{pad((peakHour.hour + 1) % 24)}:00 ·
                        {peakHour.orders} заказов
                    </span>
                </div>
            </div>
            {#if showSkeletons}
                <div class="sk-chart" aria-hidden="true"></div>
            {:else}
                <div class="hour-chart">
                    {#each hours as point (point.hour)}
                        <div
                            class="hour-col"
                            title="{pad(point.hour)}:00 — {point.orders} заказов, {formatCurrency(
                                point.revenue,
                            )}"
                        >
                            <div
                                class="hour-bar"
                                class:peak={point.hour === peakHour.hour &&
                                    point.orders > 0}
                                class:is-empty={point.orders === 0}
                                style="height: {point.orders === 0
                                    ? 2
                                    : Math.max(4, Math.round((point.orders / hoursMax) * 100))}%"
                            ></div>
                        </div>
                    {/each}
                </div>
                <div class="hour-axis">
                    {#each hours as point (point.hour)}
                        <span>{point.hour % 3 === 0 ? pad(point.hour) : ""}</span>
                    {/each}
                </div>
            {/if}
            </div>
        </div>

        <div class="breakdown-grid">
            <div class="panel glass-panel">
                <span class="panel-title-row">
                    <h3 class="panel-title">Топ товаров · {periodLabel}</h3>
                    <InfoTip
                        text="Товары с наибольшей выручкой за выбранный месяц. Под названием — артикул и SKU, чтобы различать одинаковые по названию варианты; клик открывает товар в остатках. Ниже — какая доля всей выручки приходится на верхушку ассортимента (топ-20% SKU)."
                        label="Пояснение к топу товаров"
                    />
                </span>
                {#if showSkeletons}
                    <div class="sk-chart" aria-hidden="true"></div>
                {:else if top.length === 0}
                    <p class="muted-note">Нет продаж за период.</p>
                {:else}
                    <div class="top-list">
                        {#each top as product (product.sku)}
                            <div class="mini-row top-row">
                                <span class="top-name" title={product.name}>
                                    {#if $dashboardData?.skuToImage?.[product.sku]}
                                        <img
                                            class="top-thumb"
                                            src={$dashboardData.skuToImage[product.sku]}
                                            alt=""
                                            width="32"
                                            height="32"
                                            loading="lazy"
                                            decoding="async"
                                        />
                                    {/if}
                                    <span class="top-text">
                                        <a
                                            class="top-link"
                                            href="/stocks?highlight={product.sku}"
                                            >{product.name}</a
                                        >
                                        <span class="top-sub">
                                            {product.offerId || "без артикула"} · SKU {
                                                product.sku
                                            }
                                        </span>
                                    </span>
                                </span>
                                <span class="mini-value"
                                    >{formatCurrency(product.revenue)} · {product.units}
                                    шт</span
                                >
                            </div>
                        {/each}
                    </div>
                    <p class="panel-note">
                        Топ {concentration.topCount} из {concentration.skuCount} SKU дают
                        {formatPercent(concentration.topShare)} выручки
                    </p>
                {/if}
            </div>

            <div class="panel glass-panel">
                <span class="panel-title-row">
                    <h3 class="panel-title">География · {periodLabel}</h3>
                    <InfoTip
                        text="Выручка по городам доставки (analytics_data.city) за выбранный месяц. Процент — доля города в общей выручке."
                        label="Пояснение к географии"
                    />
                </span>
                {#if showSkeletons}
                    <div class="sk-chart" aria-hidden="true"></div>
                {:else if cities.length === 0}
                    <p class="muted-note">Нет данных.</p>
                {:else}
                    <div class="mini-list">
                        {#each cities as city (city.name)}
                            <div class="mini-row">
                                <span class="mini-name" title={city.name}>{city.name}</span>
                                <span class="mini-value"
                                    >{formatCurrency(city.revenue)} · {formatPercent(
                                        city.share,
                                    )}</span
                                >
                            </div>
                            <div
                                class="mini-bar"
                                style="width: {Math.round(city.share)}%"
                            ></div>
                        {/each}
                    </div>
                {/if}
            </div>

            <div class="panel glass-panel">
                <span class="panel-title-row">
                    <h3 class="panel-title">Способ оплаты · {periodLabel}</h3>
                    <InfoTip
                        text="Выручка по группам способов оплаты (analytics_data.payment_type_group_name) за выбранный месяц."
                        label="Пояснение к способам оплаты"
                    />
                </span>
                {#if showSkeletons}
                    <div class="sk-chart" aria-hidden="true"></div>
                {:else if payments.length === 0}
                    <p class="muted-note">Нет данных.</p>
                {:else}
                    <div class="mini-list">
                        {#each payments as payment (payment.name)}
                            <div class="mini-row">
                                <span class="mini-name" title={payment.name}
                                    >{payment.name}</span
                                >
                                <span class="mini-value"
                                    >{formatCurrency(payment.revenue)} · {formatPercent(
                                        payment.share,
                                    )}</span
                                >
                            </div>
                            <div
                                class="mini-bar"
                                style="width: {Math.round(payment.share)}%"
                            ></div>
                        {/each}
                    </div>
                {/if}
            </div>

            <div class="panel glass-panel">
                <span class="panel-title-row">
                    <h3 class="panel-title">Маршруты кластеров · {periodLabel}</h3>
                    <InfoTip
                        text="Откуда и куда ехал заказ (cluster_from → cluster_to). Число — количество заказов, сумма — их выручка. Кросс-кластерные маршруты обычно дороже по логистике."
                        label="Пояснение к маршрутам кластеров"
                    />
                </span>
                {#if showSkeletons}
                    <div class="sk-chart" aria-hidden="true"></div>
                {:else if routes.length === 0}
                    <p class="muted-note">Нет данных.</p>
                {:else}
                    <div class="mini-list">
                        {#each routes as route (route.from + "→" + route.to)}
                            <div class="mini-row">
                                <span class="mini-name" title="{route.from} → {route.to}"
                                    >{route.from} → {route.to}</span
                                >
                                <span class="mini-value"
                                    >{route.orders} · {formatCurrency(route.revenue)}</span
                                >
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>

            <div class="panel glass-panel">
                <span class="panel-title-row">
                    <h3 class="panel-title">Акции и теги · {periodLabel}</h3>
                    <InfoTip
                        text="Заказы, у которых в financial_data есть теги/акции, и их доля от всех заказов за выбранный месяц."
                        label="Пояснение к акциям и тегам"
                    />
                </span>
                {#if showSkeletons}
                    <div class="sk-chart" aria-hidden="true"></div>
                {:else if actionStats.length === 0}
                    <p class="muted-note">Заказы без тегов.</p>
                {:else}
                    <div class="mini-list">
                        {#each actionStats as action (action.action)}
                            <div class="mini-row">
                                <span class="mini-name" title={action.action}
                                    >{action.action}</span
                                >
                                <span class="mini-value"
                                    >{action.orders} · {formatCurrency(action.revenue)}</span
                                >
                            </div>
                        {/each}
                    </div>
                    <p class="panel-note">
                        {formatPercent(promo.promoShare)} заказов с тегами ({promo.promoOrders} из
                        {promo.promoOrders + promo.organicOrders})
                    </p>
                {/if}
            </div>
        </div>
    </section>


    



    {/if}

    {#if showCogs}
        <CogsPanel products={costCandidates} onClose={() => (showCogs = false)} />
    {/if}

    <!--
        Tap the top of the screen to go back up, the way a phone in standalone mode cannot do
        for itself. Touch devices only, and inert until the header has scrolled away so it can
        never intercept the buttons underneath it.
    -->
    <div
        class="top-strip"
        class:is-active={showTopStrip}
        onclick={scrollToTop}
        aria-hidden="true"
    ></div>

    <!--
        Back to the top, on a pointer device only. The ring is the page's own scroll position,
        so the control answers "how far down am I" as well as "take me up" — one element
        instead of a button plus a progress bar. Hidden below 768 px: a thumb flicks back
        faster than it aims at a floating target.
    -->
    <button
        type="button"
        class="to-top"
        class:is-visible={showToTop}
        onclick={scrollToTop}
        title="Наверх"
        aria-label="Вернуться наверх"
    >
        <!--
            Ring and arrow in one viewBox. As separate elements — an absolutely positioned SVG
            and a centred span — they were laid out by two different rules and drifted apart.
            The ring is rotated inside the SVG rather than the SVG itself, so the arrow stays
            upright: 131.95 is the circumference of r=21.
        -->
        <svg viewBox="0 0 48 48" aria-hidden="true">
            <circle class="to-top-track" cx="24" cy="24" r="21" />
            <circle
                class="to-top-ring"
                cx="24"
                cy="24"
                r="21"
                stroke-dasharray="131.95"
                stroke-dashoffset={131.95 * (1 - scrollProgress)}
            />
            <path class="to-top-arrow" d="M24 32 V17 M18.5 22.5 L24 17 L29.5 22.5" />
        </svg>
    </button>
</div>

<style>
    /* Font optimization: Moved to app.html for zero CLS */

    /* Redundant :root and :global(body) removed (now in app.css) */

    .dashboard {
        max-width: var(--max-content-width);
        margin: 0 auto;
        padding: var(--space-lg) var(--space-md);
    }

    .action-tag {
        font-size: 0.7rem;
        background: transparent;
        color: var(--text-secondary);
        padding: 0.1rem 0.35rem;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        line-height: 1.2;
    }

    .no-actions {
        color: var(--text-muted);
        font-size: 0.8125rem;
    }

    /* The orders list needs the section rhythm, not a panel of its own. */
    .details-section {
        margin-bottom: var(--space-xxl);
    }

    .pagination {
        display: flex;
        align-items: center;
        gap: 1rem;
    }

    .btn-page {
        background: transparent;
        border: 1px solid var(--border-subtle);
        color: var(--text-primary);
        padding: 0.4rem 0.8rem;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: 0.85rem;
    }

    .btn-page:disabled {
        opacity: 0.3;
        cursor: not-allowed;
    }

    .page-info {
        font-size: 0.75rem;
        color: var(--text-muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .product-link {
        color: var(--text-primary);
        text-decoration: none;
        font-weight: 500;
        transition: color 0.2s;
    }

    .product-link:hover {
        color: var(--accent-gold);
        text-decoration: underline;
    }

    .status-pill {
        padding: 6px 10px;
        font-size: 0.65rem;
        text-transform: uppercase;
        font-weight: 600;
        letter-spacing: 0.05em;
        border-radius: var(--radius-sm);
        border: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }

    .status-pill[data-status="delivering"] {
        background: rgba(99, 102, 241, 0.15);
        color: #818cf8;
    }

    .status-pill[data-status="cancelled"] {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
    }

    .status-pill[data-status="delivered"] {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
    }

    /* Buyer money on the left, seller money on the right — never presented as one
       number, because the difference is what the business actually earns. */
    .money-gross {
        color: var(--text-muted);
        font-weight: 400;
    }

    .money-arrow {
        margin: 0 6px;
        color: var(--text-disabled);
    }

    .money-net {
        color: var(--success);
        font-weight: 600;
    }

    .route-info {
        display: flex;
        align-items: center;
        gap: var(--space-xs);
        white-space: normal;
        padding: var(--space-xs) var(--space-sm);
        border-radius: var(--radius-sm);
        transition: all 0.3s ease;
        flex-wrap: wrap;
        font-size: var(--text-sm);
        /*
            Hugs its own text. As a grid item it filled the whole column, so the cross-cluster
            outline ran to the card's edge instead of marking the route it describes.
        */
        width: fit-content;
        max-width: 100%;
    }

    .route-info.is-cross-cluster {
        background: rgba(212, 175, 55, 0.05); /* Very subtle gold tint */
        border: 1px solid rgba(212, 175, 55, 0.2);
        color: #d4af37;
    }

    .route-info.is-cross-cluster .arrow-icon {
        color: #d4af37;
        opacity: 1;
    }

    .arrow-icon {
        color: var(--text-muted);
        font-weight: 700;
        opacity: 0.8;
    }

    /* How much of the window this page is showing; the pager keeps the right edge. */
    .section-note {
        margin-left: var(--space-sm);
        margin-right: auto;
        font-size: 0.75rem;
        color: var(--text-muted);
    }

    /*
        Recent orders read as cards, not as a table.
        Eight columns could not fit a phone: the mobile rule forced a 720px minimum width, so
        the whole page scrolled sideways. A card with a product line and a row of key/value
        pairs wraps instead, and every field the table carried is still here.
    */
    .order-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(460px, 100%), 1fr));
        gap: var(--space-sm);
    }

    .order-card {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 12px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: var(--bg-card);
    }

    /*
        Date, status, payment and route on one wrapping line. As four stacked rows they cost a
        third of the card's height and left most of its width empty; on one line the card reads
        as a record rather than as a form.
    */
    .order-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 10px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border-subtle);
    }

    .order-date {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
    }

    .order-lines {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);
    }

    .order-line {
        display: flex;
        gap: 8px;
        align-items: center;
        min-width: 0;
    }

    /* `min-width: 0` is what lets a long product name wrap instead of widening the card. */
    .line-body {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .product-link {
        overflow-wrap: anywhere;
    }

    /* The article on the left, its money on the right of the same line. */
    .line-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
    }

    .line-money {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 5px;
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
    }

    /* SKU and commission: one muted line under the article, not two more paragraphs. */
    .line-sub {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px;
        font-size: 0.72rem;
        color: var(--text-muted);
    }

    .line-dot {
        opacity: 0.6;
    }

    /* Pushed to the right of the header, so the card's width carries information. */
    .order-facts {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 14px;
        margin-left: auto;
    }

    .fact {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
        font-size: 0.8rem;
        color: var(--text-secondary);
    }

    .fact-label {
        font-size: var(--text-xs);
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .order-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding-top: 6px;
        border-top: 1px solid var(--border-subtle);
    }

    .meta-city {
        opacity: 0.5;
        font-size: 0.8em;
    }

    .order-empty {
        padding: 48px 24px;
        text-align: center;
        color: var(--text-muted);
        font-size: 0.875rem;
    }

    .skeleton-card {
        gap: var(--space-sm);
    }

    /* A narrower second line, so a loading card reads as a card rather than a bar. */
    .sk-line.short {
        width: 40%;
    }

    .error-card {
        background: transparent;
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        padding: 1rem;
        border-radius: var(--radius-sm);
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-bottom: 2rem;
    }

    .skeleton {
        display: inline-block;
        height: 1.5rem;
        width: 100px;
        background: var(--border-subtle);
        border-radius: var(--radius-sm);
        position: relative;
        overflow: hidden;
    }

    .skeleton::after {
        content: "";
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.05),
            transparent
        );
        animation: shimmer 1.5s infinite;
    }

    .stats-section {
        margin-bottom: var(--space-xxl);
    }

    /*
        One rule, not two. This was declared twice — once with a bottom margin, once with
        `margin: 0` — so the second silently cancelled the first and every section title sat
        flush against its content, while an `opacity: 0.9` from the cancelled rule still
        dimmed every heading. The header wrapper below carries the gap instead, which is what
        the markup assumes.
    */
    .section-title {
        font-family: var(--font-heading);
        font-size: 1.25rem;
        color: var(--text-primary);
        font-weight: 600;
        letter-spacing: 0.05em;
        margin: 0;
    }

    /* Bento Grid System */
    .bento-header {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-bottom: var(--space-lg);
    }

    /*
        Kept from the bento that used to live here: the panel surface every section shares,
        and the small currency suffix the card values read.
    */
    .glass-panel {
        background: rgba(20, 20, 20, 0.4);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.08); /* 0.5px visual feel */
        border-radius: 20px;
        box-shadow: 0 4px 24px -1px rgba(0, 0, 0, 0.2);
    }

    .unit {
        font-size: 0.875rem;
        color: var(--text-muted);
        opacity: 0.5;
        margin-left: 4px;
    }

    /* --- The four "right now" cards --- */

    .period-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 16px;
    }

    @media (max-width: 1280px) {
        .period-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }

    @media (max-width: 700px) {
        .period-grid {
            grid-template-columns: 1fr;
        }
    }

    /*
        One card per period, laid out as SellerBoard lays its own: a coloured head, then the
        money in a two-column grid with Sales spanning both. The tone is the only thing that
        differs between the cards, so it is set once per card as a custom property and every
        rule below reads it.
    */
    /*
        No `overflow: hidden` here: the metrics open tooltips, and a clipped card would cut
        them off at its own edge. The coloured head is rounded instead, which is what the
        clipping used to achieve.
    */
    .period-card {
        --tone: var(--accent-gold);
        --tone-soft: rgba(234, 179, 8, 0.14);
        --tone-line: rgba(234, 179, 8, 0.32);
        position: relative;
        display: flex;
        flex-direction: column;
        transition:
            transform 0.3s ease,
            box-shadow 0.3s ease;
    }

    /*
        The card itself has to rise, not just the bubble inside it. Every card is its own
        stacking context — a blurred, transformed panel — so a bubble's own `z-index` is trapped
        inside it and the next card paints straight over the explanation. Raising the hovered or
        focused card puts its whole bubble above its neighbours, which is what the reader sees
        when they point at a metric in the first or last card.
    */
    .period-card:hover,
    .period-card:focus-within {
        z-index: 30;
    }

    .period-card:hover {
        transform: translateY(-2px);
    }

    .tone-today {
        --tone: #3b82f6;
        --tone-soft: rgba(59, 130, 246, 0.16);
        --tone-line: rgba(59, 130, 246, 0.34);
    }

    .tone-yesterday {
        --tone: #38bdf8;
        --tone-soft: rgba(56, 189, 248, 0.14);
        --tone-line: rgba(56, 189, 248, 0.3);
    }

    .tone-monthToDate {
        --tone: #14b8a6;
        --tone-soft: rgba(20, 184, 166, 0.14);
        --tone-line: rgba(20, 184, 166, 0.3);
    }

    .tone-lastMonth {
        --tone: #22c55e;
        --tone-soft: rgba(34, 197, 94, 0.14);
        --tone-line: rgba(34, 197, 94, 0.3);
    }

    .period-card-head {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-sm) var(--space-md);
        background: var(--tone-soft);
        /* The card's own radius, since the card no longer clips its children. */
        border-radius: 20px 20px 0 0;
        border-bottom: 1px solid var(--tone-line);
    }

    .period-card-title {
        font-family: var(--font-heading);
        font-size: 0.95rem;
        font-weight: 700;
        color: var(--text-primary);
    }

    .period-card-range {
        font-size: var(--text-xs);
        color: var(--text-secondary);
    }

    .period-card-body {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--space-md);
        padding: var(--space-md);
    }

    /*
        The metric wrappers themselves live in `MetricTip` now, which owns the label, the
        tooltip and the layout; what is left here styles the figures the cards pass into it.
    */
    .metric-value {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 6px;
        font-family: var(--font-heading);
        font-size: 1rem;
        font-weight: 600;
        color: var(--text-primary);
    }

    .metric-lead {
        font-size: clamp(1.5rem, 1.2rem + 0.8vw, 2rem);
        letter-spacing: -0.02em;
    }

    .metric-aside {
        font-size: 0.8rem;
        font-weight: 500;
        color: var(--text-secondary);
    }

    .metric-delta {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--success);
    }

    .metric-delta.negative {
        color: var(--error);
    }

    /* What the percentage is against: same size, quieter, so the change stays the loud half. */
    .metric-delta-base {
        margin-left: 4px;
        font-weight: 500;
        color: var(--text-muted);
    }

    /* A withheld figure: not zero, and not a colour that reads as one. */
    .metric-unknown {
        color: var(--text-disabled);
    }

    @keyframes shimmer {
        0% {
            transform: translateX(-100%);
        }
        100% {
            transform: translateX(100%);
        }
    }

    .product-image-container {
        width: 64px;
        height: 64px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        overflow: hidden;
        background: rgba(255, 255, 255, 0.02);
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .product-image-container.small {
        width: 40px;
        height: 40px;
    }

    .product-thumb {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .product-thumb-placeholder {
        color: var(--text-muted);
        opacity: 0.3;
    }

    /* --- Analytics insights (tiers 1-4) --- */

    .insights-section {
        margin-bottom: var(--space-xxl);
    }

    .kpi-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr));
        gap: 12px;
        margin-bottom: var(--space-lg);
    }

    .kpi-chip {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: var(--space-md);
        border-radius: var(--radius-md);
    }

    .kpi-chip.alert {
        border-color: rgba(239, 68, 68, 0.35);
    }

    .kpi-label {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--text-muted);
    }

    .kpi-value {
        font-family: var(--font-heading);
        font-size: 1.2rem;
        font-weight: 700;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
    }

    .kpi-delta {
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .positive {
        color: var(--success);
    }

    .negative {
        color: var(--error);
    }

    .panel {
        padding: var(--space-lg);
        border-radius: var(--radius-md);
    }

    .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--space-md);
        margin-bottom: var(--space-md);
        flex-wrap: wrap;
    }

    .panel-controls {
        display: flex;
        align-items: center;
        gap: var(--space-md);
        flex-wrap: wrap;
        justify-content: flex-end;
    }

    .panel-title-group,
    .panel-title-row {
        display: inline-flex;
        align-items: center;
        gap: 8px;
    }

    .panel-title-row {
        margin-bottom: var(--space-md);
    }

    .panel-title {
        margin: 0 0 var(--space-md);
        font-family: var(--font-heading);
        font-size: 0.85rem;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-primary);
    }

    .panel-head .panel-title,
    .panel-title-group .panel-title,
    .panel-title-row .panel-title {
        margin: 0;
    }

    .muted-note {
        color: var(--text-muted);
        font-size: var(--text-sm);
        margin: 0;
    }

    /* Sits under a KPI strip, so it needs air rather than to touch the chips. */
    .panel-note {
        margin: var(--space-sm) 0 0;
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .mini-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .mini-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--space-sm);
        font-size: var(--text-sm);
        color: var(--text-secondary);
    }

    /* Long product names wrap instead of being cut off; the full text is also
       available through the native `title` tooltip. */
    .mini-name {
        flex: 1 1 auto;
        min-width: 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
        line-height: 1.35;
    }

    /* Top products get their own full-width panel, so the long names have room.
       Each row still shows a thumbnail, the article and the SKU, so identical
       names (the same case in different designs) stay distinguishable. */
    .top-list {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr));
        gap: 10px 24px;
    }

    .top-row {
        align-items: flex-start;
    }

    .top-name {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .top-thumb {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        object-fit: cover;
    }

    .top-text {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
    }

    .top-link {
        color: var(--text-primary);
        text-decoration: none;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
        line-height: 1.3;
    }

    .top-link:hover {
        color: var(--accent-gold);
        text-decoration: underline;
    }

    .top-sub {
        font-size: 0.66rem;
        color: var(--text-muted);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
        line-height: 1.3;
    }

    .mini-value {
        flex: 0 0 auto;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        color: var(--text-primary);
    }

    .top-row .mini-value {
        padding-top: 2px;
    }

    .mini-bar {
        height: 4px;
        max-width: 100%;
        border-radius: 2px;
        background: var(--accent-gold);
        opacity: 0.5;
    }

    .trend-panel {
        padding: var(--space-lg);
    }

    .trend-chart {
        display: flex;
        align-items: flex-end;
        gap: 6px;
        height: 160px;
    }

    .trend-bar-wrap {
        flex: 1;
        display: flex;
        align-items: flex-end;
        height: 100%;
    }

    .trend-bar {
        width: 100%;
        min-height: 2px;
        border-radius: 4px 4px 0 0;
        background: linear-gradient(180deg, #818cf8, #6366f1);
    }

    .trend-axis {
        display: flex;
        justify-content: space-between;
        margin-top: 8px;
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    /*
        The control is a ring around an arrow: the same circle reports the position and does
        the work. Everything is in the SVG so it stays crisp at any density, and the surface
        is translucent with a blur rather than a solid panel, so it reads as floating over the
        page instead of sitting on it.
    */
    .to-top {
        position: fixed;
        right: var(--space-lg);
        bottom: var(--space-lg);
        width: 48px;
        height: 48px;
        display: grid;
        place-items: center;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: rgba(18, 18, 22, 0.72);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: var(--text-secondary);
        cursor: pointer;
        z-index: 40;
        opacity: 0;
        pointer-events: none;
        transform: translateY(10px) scale(0.92);
        transition:
            opacity 0.25s ease,
            transform 0.25s ease,
            color 0.2s ease;
    }

    .to-top.is-visible {
        opacity: 1;
        pointer-events: auto;
        transform: none;
    }

    .to-top:hover {
        color: var(--text-primary);
    }

    .to-top svg {
        /* Exactly the button's box, so the ring is centred by construction. */
        width: 100%;
        height: 100%;
        display: block;
    }

    .to-top-track {
        fill: none;
        stroke: var(--border-subtle);
        stroke-width: 2;
    }

    .to-top-ring {
        fill: none;
        stroke: var(--accent-gold);
        stroke-width: 2;
        stroke-linecap: round;
        transition: stroke-dashoffset 0.1s linear;
        /* Starts at twelve o'clock and fills clockwise, like every progress ring. Turning the
           ring rather than the SVG keeps the arrow upright. */
        transform: rotate(-90deg);
        transform-origin: 24px 24px;
    }

    .to-top-arrow {
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        transition: transform 0.2s ease;
        transform-origin: 24px 24px;
    }

    .to-top:hover .to-top-arrow {
        transform: translateY(-2px);
    }

    /* A thumb flicks back faster than it aims at a floating target. */
    @media (max-width: 768px) {
        .to-top {
            display: none;
        }
    }

    /* The ring is the only thing that moves there; a slide would contradict the request. */
    @media (prefers-reduced-motion: reduce) {
        .to-top,
        .to-top-arrow,
        .to-top-ring {
            transition: none;
        }
    }

    /*
        Two per row once there is room. These panels are label-and-value rows, so at full
        width the label sat at one edge and the number at the other with nothing between —
        the row was mostly gap. The grid rule itself had been deleted while the class stayed
        in the markup, which is why they were stacking one per row.
    */
    .breakdown-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: var(--space-lg);
    }

    @media (min-width: 1100px) {
        .breakdown-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        /* The top-products mosaic is not a list — four products across — so it keeps a full
           row of its own rather than being squeezed into half. */
        .breakdown-grid > .panel:first-child {
            grid-column: 1 / -1;
        }
    }

    /*
        The month-over-month line under «Начислено за месяц». It was written into the markup
        without a rule of its own, so it inherited the cell's full-size type and read as a
        second figure rather than as a footnote to the first.
    */
    .payout-note {
        display: block;
        margin-top: 2px;
        font-size: var(--text-xs);
        color: var(--text-muted);
    }

    /*
        The tap area along the top of the viewport, for touch only. Tall enough to catch a
        thumb without aiming, and inert until the header is gone — see `showTopStrip`.
    */
    .top-strip {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 64px;
        z-index: 45;
        pointer-events: none;
        /* No surface of its own: it is the screen's top edge, not a control on it. */
        background: transparent;
    }

    .top-strip.is-active {
        pointer-events: auto;
    }

    /* A mouse already has the ring, and clicking the page's top edge is not a gesture. */
    @media (pointer: fine) {
        .top-strip {
            display: none;
        }
    }

    /* --- Hourly activity --- */

    /*
        One row for the two month-scoped charts on a screen wide enough to hold them. The
        container is capped at 1600 px, so below this the charts keep their own row: a
        thirty-day chart squeezed into half of 900 px would be unreadable.
    */
    .charts-row {
        display: grid;
        grid-template-columns: 1fr;
        gap: var(--space-lg);
        margin-bottom: var(--space-lg);
    }

    @media (min-width: 1280px) {
        .charts-row {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }

    .hour-panel {
        margin-bottom: 0;
    }

    .hour-chart {
        display: flex;
        align-items: flex-end;
        gap: 6px;
        height: 150px;
    }

    .hour-col {
        flex: 1;
        display: flex;
        align-items: flex-end;
        height: 100%;
    }

    .hour-bar {
        width: 100%;
        min-height: 2px;
        border-radius: 3px 3px 0 0;
        background: linear-gradient(180deg, #34d399, #10b981);
        transition: filter var(--transition-fast);
    }

    .hour-bar.peak {
        background: linear-gradient(180deg, #fbbf24, #eab308);
        box-shadow: 0 0 12px -2px rgba(234, 179, 8, 0.6);
    }

    .hour-col:hover .hour-bar {
        filter: brightness(1.3);
    }

    .hour-axis {
        display: flex;
        gap: 6px;
        margin-top: 6px;
        font-size: 0.65rem;
        color: var(--text-muted);
    }

    .hour-axis span {
        flex: 1;
        text-align: center;
    }

    /* --- Mobile / small-screen layout --- */
    @media (max-width: 640px) {
        .dashboard {
            max-width: 100%;
            padding: var(--space-md) var(--space-sm);
        }

        .stats-section,
        .insights-section {
            margin-bottom: var(--space-xl);
        }

        .section-title {
            font-size: 1.05rem;
        }

        .bento-header {
            flex-wrap: wrap;
            gap: var(--space-sm);
        }

        .panel {
            padding: var(--space-md);
        }

        /* Titles and their controls stack instead of squeezing. */
        .panel-head {
            flex-direction: column;
            align-items: stretch;
            gap: var(--space-sm);
        }

        .panel-controls {
            justify-content: flex-start;
        }

        /* Charts get a little shorter and tighter. */
        .trend-chart,
        .hour-chart {
            height: 120px;
            gap: 3px;
        }

        .hour-axis {
            gap: 3px;
        }

    }

    /* --- Loading, empty and error states --- */

    /* Timestamp of the payload on screen; announced politely when it changes. */
    .updated-at {
        margin-left: auto;
        font-size: 0.7rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    /* Placeholder shapes. Sizes mirror the content they stand in for, so the
       layout does not jump when the numbers arrive. */
    .sk-medium {
        height: 2rem;
        width: 60%;
        margin: var(--space-sm) 0;
    }

    .sk-line {
        height: 0.7rem;
        width: 45%;
    }

    .sk-chip {
        height: 1.3rem;
        width: 65%;
    }

    /* One block standing in for a whole chart or list. */
    .sk-chart {
        height: 120px;
        border-radius: var(--radius-sm);
        background: var(--border-subtle);
        position: relative;
        overflow: hidden;
    }

    .sk-chart::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.05),
            transparent
        );
        animation: shimmer 1.5s infinite;
    }

    /* A day/hour with no sales keeps a hairline marker but stops reading as a bar. */
    .trend-bar.is-empty,
    .hour-bar.is-empty {
        background: rgba(255, 255, 255, 0.12);
    }

    .error-text {
        flex: 1 1 auto;
        min-width: 0;
    }

    .error-text p {
        margin: 0;
    }

    .error-note {
        margin-top: 4px !important;
        font-size: 0.75rem;
        color: var(--text-muted);
    }

    .btn-retry {
        flex: 0 0 auto;
        background: transparent;
        border: 1px solid var(--border-hover);
        color: var(--text-primary);
        padding: 0.5rem 1rem;
        min-height: 36px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-family: inherit;
        font-size: 0.75rem;
        font-weight: 600;
    }

    .btn-retry:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.06);
    }

    .btn-retry:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .no-data,
    .state-note {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--space-sm);
    }

    .no-data p,
    .state-note p {
        margin: 0;
    }

    /* --- Margin and assortment --- */

    .btn-inline {
        margin-left: auto;
        background: transparent;
        border: 1px solid var(--border-hover);
        color: var(--text-primary);
        padding: 0.4rem 0.9rem;
        min-height: 36px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-family: inherit;
        font-size: 0.72rem;
        font-weight: 600;
        white-space: nowrap;
    }

    .btn-inline:hover {
        background: rgba(255, 255, 255, 0.06);
    }

    /*
        The month control and the cost book, on the right of the money section's heading. They
        sit in the section they drive rather than in a bar of their own above every money
        section: the cards at the top of the page ignore this control by design, and a bar
        spanning the page read as though it filtered them too.
    */
    .period-inline {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-sm);
        margin-left: auto;
    }

    .period-title {
        font-family: var(--font-heading);
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--text-primary);
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }

    /* --- Month: payout, weekly split, tax and cost --- */
    .payout-panel,
    .tax-panel {
        margin-top: var(--space-md);
    }

    .payout-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-sm);
    }

    .payout-cell {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: var(--space-sm) var(--space-md);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.02);
    }

    .payout-label {
        font-size: 0.7rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .payout-value {
        font-family: var(--font-heading);
        font-size: 1.05rem;
        font-weight: 600;
        color: var(--text-primary);
    }

    .panel-subtitle {
        margin: var(--space-md) 0 var(--space-sm);
        font-family: var(--font-heading);
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.07em;
    }

    /* Settlement table: eight columns, so the rows scroll rather than wrap on narrow screens. */
    .week-table {
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow-x: auto;
    }

    /*
        Five columns: period, orders, returns, commission, payout. The service and delivery
        columns were removed rather than kept with a caveat — the statement's `services_amount`
        could not be reproduced from the accruals on any date basis or with a week's shift, and
        it reports a positive service total in a period whose actual service charges are
        negative. An unexplained figure beside verified ones invites the wrong conclusion.
    */
    .week-row {
        display: grid;
        grid-template-columns: 96px repeat(3, minmax(96px, 1fr)) minmax(104px, 1fr);
        min-width: 520px;
        gap: var(--space-sm);
        align-items: center;
        padding: 7px var(--space-sm);
        border-radius: 4px;
        font-size: 0.78rem;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    .week-row:not(.week-head):nth-child(odd) {
        background: rgba(255, 255, 255, 0.02);
    }

    .week-head {
        color: var(--text-muted);
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--border-subtle);
    }

    .week-dates {
        color: var(--text-secondary);
        font-weight: 600;
    }

    .week-net {
        color: var(--text-primary);
        font-weight: 600;
    }

    .negative {
        color: var(--accent-red, #f87171);
    }

    /*
        On a phone the five columns cannot fit, and a sideways-scrolling page is worse than a
        taller one. Each row becomes a block of label/value pairs instead: the header row is
        dropped, the period stands as the block's heading, and every other cell carries its
        own label from `data-label`.
    */
    @media (max-width: 560px) {
        /*
            Two selectors, not one: `.breakdown-row` sets its own three-track template further
            down this file, so a bare `.week-row` here would lose to it on source order and the
            tracks' 460 px of minimums would push the page wider than a phone. The second
            selector outweighs it on specificity instead.
        */
        .week-row,
        .week-row.breakdown-row {
            grid-template-columns: 1fr;
            min-width: 0;
            gap: 3px;
            white-space: normal;
        }

        .week-head {
            display: none;
        }

        .week-row[role="row"] > [role="cell"] {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: var(--space-sm);
        }

        .week-row[role="row"] > [role="cell"][data-label]::before {
            content: attr(data-label);
            color: var(--text-muted);
            font-size: 0.72rem;
        }

        /* The period heads its block, so it needs no value beside it. */
        .week-dates {
            margin-bottom: 2px;
        }
    }

    .tax-controls {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-md);
        margin-bottom: var(--space-md);
    }

    .tax-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.72rem;
        color: var(--text-muted);
    }

    .tax-field input,
    .tax-field select {
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-family: inherit;
        font-size: 0.82rem;
        padding: 8px 10px;
        min-height: 38px;
        min-width: 190px;
    }

    .tax-field input {
        min-width: 96px;
        max-width: 120px;
    }

    .tax-field input:focus-visible,
    .tax-field select:focus-visible {
        outline: 2px solid var(--accent-gold);
        outline-offset: 1px;
    }

    /* The chain reads left to right: income, minus cost, minus tax, equals what is left. */
    .tax-chain {
        display: flex;
        flex-wrap: wrap;
        align-items: stretch;
        gap: var(--space-sm);
    }

    .chain-step {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1 1 168px;
        padding: var(--space-sm) var(--space-md);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.02);
    }

    .chain-result {
        border-color: rgba(234, 179, 8, 0.4);
        background: rgba(234, 179, 8, 0.06);
    }

    .chain-label {
        font-size: 0.7rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .chain-value {
        font-family: var(--font-heading);
        font-size: 1.05rem;
        font-weight: 600;
        color: var(--text-primary);
    }

    .chain-value.positive {
        color: var(--accent-green, #4ade80);
    }

    .chain-value.negative {
        color: var(--accent-red, #f87171);
    }

    .chain-note {
        font-size: 0.7rem;
        color: var(--text-muted);
        line-height: 1.35;
    }

    .chain-arrow {
        align-self: center;
        font-size: 1.1rem;
        color: var(--text-muted);
    }

    /*
        Breakdown of the accrued amount: a label, an amount and their composition. The two
        flanking tracks may be narrow because the mobile block above collapses this row to one
        column, where the minimums never apply.
    */
    .breakdown-row {
        grid-template-columns: minmax(160px, 1.1fr) minmax(100px, 0.7fr) minmax(200px, 2fr);
        min-width: 0;
    }

    .breakdown-head {
        color: var(--text-muted);
    }

    .breakdown-detail {
        color: var(--text-muted);
        font-size: 0.72rem;
        white-space: normal;
    }

    .breakdown-total {
        border-top: 1px solid var(--border-subtle);
        font-weight: 600;
        color: var(--text-primary);
    }

    .breakdown-note {
        margin-bottom: var(--space-sm);
    }
</style>
