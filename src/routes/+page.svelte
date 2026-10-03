<script lang="ts">
    import { getDashboardData, getStocksData, getEconomicsData, getTurnoverData, type TurnoverPayload } from "$lib/ozon_api";
    import { summariseTurnover, gradeLabel } from "$lib/turnover";
    import {
        cachedWindow,
        daysToFetch,
        emptyAccrualCache,
        mergeAccrualDays,
        pruneAccrualCache,
        // Aliased: the page already has a `windowDays` state for the trend toggle.
        windowDays as accrualWindowDays,
        type AccrualCache,
    } from "$lib/accrual_cache";
    import { summariseFinance, groupTotals, FEE_GROUP_LABELS, typeLabel } from "$lib/pnl";
    import {
        mergeDashboardPayload,
        needsFullLoad,
        refreshSince,
    } from "$lib/dashboard_cache";
    import type { DashboardPayload } from "$lib/ozon_types";
    import { peekCache, useSWR } from "$lib/swr";
    import { refreshOnKeysChange } from "$lib/refresh_on_keys";
    import {
        averageOrderValue,
        averageUnitPrice,
        calculateStats,
        cancellationRate,
        productUnitPrice,
        unitsPerOrder,
    } from "$lib/stats";
    import {
        actionBreakdown,
        byCity,
        byPaymentType,
        clusterRoutes,
        compareWindows,
        dailyTrend,
        hourlyActivity,
        promoShare,
        revenueConcentration,
        STATUS_LABELS,
        statusBreakdown,
        topProducts,
    } from "$lib/metrics";
    import { inventoryInsights } from "$lib/inventory";
    import { moneySummary, enrichLines, costBookLookup, skuEconomics, abcAnalysis, breakEvenPrice, lossMaking } from "$lib/economics";
    import { capitalSummary, suggestedOrder } from "$lib/capital";
    import { buildActions } from "$lib/actions";
    import { costBook } from "$lib/stores/cogs";
    import CogsPanel from "$lib/components/CogsPanel.svelte";
    import {
        formatCurrency,
        formatCurrencyParts,
        formatDelta,
        formatNumber,
        formatPercent,
    } from "$lib/format";
    import { ozonKeys } from "$lib/stores/ozon_keys";
    import OzonHeader from "$lib/components/OzonHeader.svelte";
    import InfoTip from "$lib/components/InfoTip.svelte";
    import RangeToggle from "$lib/components/RangeToggle.svelte";
    import { get } from "svelte/store";
    import { onDestroy } from "svelte";

    const clientId = get(ozonKeys).clientId;
    const cacheKey = `ozon-dashboard:${clientId}`;

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

            // Only the recent tail of the history can still change, so a refresh
            // asks for that window and folds it into what is already on screen.
            if (previous && !needsFullLoad(previous)) {
                return mergeDashboardPayload(
                    previous,
                    await getDashboardData(signal, refreshSince()),
                );
            }

            // The endpoint walks Ozon's cursors server-side and returns only the
            // fields the table renders, so the browser makes a single request.
            return getDashboardData(signal);
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
    // fetched once and kept in localStorage. Closed days never change, so later visits
    // ask only for the two trailing days instead of walking all 31 again.
    const FINANCE_WINDOW_DAYS = 31;
    const accrualWindow = $derived(accrualWindowDays(new Date(), FINANCE_WINDOW_DAYS));

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

    const economicsResult = useSWR(
        `ozon-economics:${clientId}`,
        async (signal) => {
            if (!$ozonKeys.clientId || !$ozonKeys.apiKey) {
                throw new Error(
                    "Укажите Client ID и API Key в настройках (шестерёнка справа сверху).",
                );
            }

            const cache = readAccrualCache();
            const window = accrualWindowDays(new Date(), FINANCE_WINDOW_DAYS);
            const missing = daysToFetch(cache, window);
            const needsTypes = Object.keys(cache.types).length === 0;

            if (missing.length === 0 && !needsTypes) return cache;

            const payload = await getEconomicsData(signal, missing, needsTypes);
            const merged = pruneAccrualCache(
                mergeAccrualDays(cache, payload.days, payload.types, payload.fetchedAt),
                window,
            );
            writeAccrualCache(merged);

            return merged;
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

    const accrualDays = $derived(
        $financeData ? cachedWindow($financeData, accrualWindow) : [],
    );
    const finance = $derived(
        summariseFinance(accrualDays, $financeData?.types ?? {}),
    );
    const financeGroups = $derived(groupTotals(finance.orderLines));
    const financeLoadError = $derived($financeError?.message ?? null);

    // Reload when the credentials change; useSWR already loads the initial value.
    // Both requests are reset first, so the previous account's payload is dropped
    // before the new one is fetched — otherwise it would stay on screen and get
    // merged into the new account's data.
    refreshOnKeysChange(() => {
        resetDashboard();
        resetStocks();
        resetFinance();
        resetTurnover();
        mutate({ force: true });
        mutateStocks({ force: true });
        mutateFinance({ force: true });
        mutateTurnover({ force: true });
    });

    // Clean up resources when component is destroyed
    onDestroy(dispose);
    onDestroy(disposeStocks);
    onDestroy(disposeFinance);

    const isUp = (value: number | null) => value !== null && value >= 0;
    const isDown = (value: number | null) => value !== null && value < 0;

    const pad = (value: number) => String(value).padStart(2, "0");

    /** Wall-clock time of the payload currently on screen. */
    function formatTime(date: Date) {
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** Short label for a posting status, falling back to the raw value. */
    const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

    /** Colors for the three window series (7 / 14 / 31 days). */
    const SERIES_COLORS = ["#6366f1", "#a855f7", "#eab308"];
    const seriesColor = (index: number) => SERIES_COLORS[index] ?? "#71717a";

    const postingsData = $derived($dashboardData?.postings ?? []);
    const error = $derived($swrError?.message ?? null);

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

    // Shared analysis window for the trend and the hourly chart (7 / 14 / 31 days).
    // The dashboard loads 31 days of history, so that is the default.
    let windowDays = $state(31);

    // --- Tier 2: breakdowns derived from the postings already in memory ---
    const trend = $derived(dailyTrend(postingsData, windowDays));
    const trendMax = $derived(Math.max(1, ...trend.map((point) => point.netRevenue)));

    const top = $derived(topProducts(postingsData, 8));
    const concentration = $derived(revenueConcentration(postingsData));
    const cities = $derived(byCity(postingsData, 6));
    const payments = $derived(byPaymentType(postingsData, 5));
    const routes = $derived(clusterRoutes(postingsData, 6));
    const actionStats = $derived(actionBreakdown(postingsData, 6));
    const promo = $derived(promoShare(postingsData));
    const deltas = $derived(compareWindows(postingsData));

    // Orders by local hour: answers "at what time do customers buy".
    const hours = $derived(hourlyActivity(postingsData, windowDays));
    const hoursMax = $derived(Math.max(1, ...hours.map((point) => point.orders)));
    const peakHour = $derived(
        hours.reduce(
            (best, point) => (point.orders > best.orders ? point : best),
            hours[0],
        ),
    );

    // Posting counts per status for the three nested windows.
    const statuses = $derived(statusBreakdown(postingsData, [7, 14, 31]));
    const statusMax = $derived(
        Math.max(1, ...statuses.rows.flatMap((row) => row.counts), ...statuses.totals),
    );

    const monthStats = $derived(stats.calendarMonth);
    const derivedMetrics = $derived([
        { label: "Средний чек", value: formatCurrency(averageOrderValue(monthStats)) },
        { label: "Доля отмен", value: formatPercent(cancellationRate(monthStats)) },
        { label: "Штук в заказе", value: unitsPerOrder(monthStats).toFixed(1) },
        { label: "Средняя цена", value: formatCurrency(averageUnitPrice(monthStats)) },
        { label: "Продано штук", value: formatNumber(monthStats.netUnits) },
        { label: "Кросс-кластер", value: formatNumber(monthStats.crossCluster) },
    ]);

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

    // --- Money, as opposed to revenue ---
    //
    // Ozon reports `payout` and `commission_amount` inside `financial_data` of the
    // same free endpoint the orders come from, so unit economics needs no paid
    // method. Cancelled orders earn nothing, hence they are left out.
    const MONEY_WINDOW_DAYS = 31;
    const paidPostings = $derived(
        postingsData.filter((posting) => posting.status !== "cancelled"),
    );
    const moneyWindow = $derived.by(() => {
        const since = Date.now() - MONEY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        return paidPostings.filter((posting) => {
            const createdAt = new Date(posting.created_at).getTime();
            return Number.isFinite(createdAt) && createdAt >= since;
        });
    });
    const money = $derived(moneySummary(moneyWindow));

    // --- Margin, which needs a cost price the API cannot supply ---
    //
    // Costs are resolved per order date, so a margin for an old period uses the price
    // that applied then instead of today's.
    const costs = $derived(costBookLookup($costBook));
    const skuRows = $derived(skuEconomics(moneyWindow, costs));

    const marginTotals = $derived.by(() => {
        // Only rows where every unit has both a payout and a cost carry a profit figure.
        const complete = skuRows.filter((row) => row.grossProfit !== null);
        const payout = complete.reduce((sum, row) => sum + row.payout, 0);
        const profit = complete.reduce((sum, row) => sum + (row.grossProfit ?? 0), 0);

        return {
            payout,
            profit,
            marginPercent: payout > 0 ? (profit / payout) * 100 : null,
            covered: complete.length,
            total: skuRows.length,
            /** Units whose cost is known, against all units sold. */
            costedUnits: skuRows.reduce(
                (sum, row) => sum + row.units * row.costCoverage,
                0,
            ),
            units: skuRows.reduce((sum, row) => sum + row.units, 0),
            /** An empty book means margin is not merely incomplete, it is unavailable. */
            hasAnyCost: skuRows.some((row) => row.costCoverage > 0)
        };
    });

    // ABC by profit once costs are known, by what the seller keeps before that: ranking
    // a catalogue by revenue is what made thin-margin bestsellers look like leaders.
    const abcUsesProfit = $derived(marginTotals.covered > 0);
    const abc = $derived(
        abcAnalysis(
            skuRows.map((row) => ({
                key: row.key,
                label: row.name,
                value: abcUsesProfit ? (row.grossProfit ?? 0) : row.payout
            })),
        ),
    );
    const abcCounts = $derived({
        A: abc.filter((row) => row.grade === "A").length,
        B: abc.filter((row) => row.grade === "B").length,
        C: abc.filter((row) => row.grade === "C").length
    });

    const losers = $derived(
        lossMaking(skuRows).map((row) => ({
            ...row,
            unitCost: row.units > 0 && row.cogs !== null ? row.cogs / row.units : null,
            breakEven: breakEvenPrice(
                row.units > 0 && row.cogs !== null ? row.cogs / row.units : null,
                row.payoutRatio
            )
        })),
    );

    let showCogs = $state(false);

    // --- Ozon's own turnover report ---
    //
    // Limited upstream to one request per minute, so the answer is cached and asked for
    // rarely. This is an enrichment: without it the dashboard still knows days of cover
    // from its own postings-versus-stock estimate.
    const TURNOVER_MIN_AGE_MS = 15 * 60 * 1000;

    function turnoverStorageKey() {
        return `ozon_turnover:${clientId}`;
    }

    function readTurnoverCache(): TurnoverPayload | null {
        try {
            const raw = localStorage.getItem(turnoverStorageKey());
            if (!raw) return null;

            const parsed = JSON.parse(raw) as TurnoverPayload;
            if (!parsed || !Array.isArray(parsed.rows) || typeof parsed.fetchedAt !== "string") {
                return null;
            }

            // A cached failure is not worth keeping: it would block a retry for minutes.
            if (parsed.error) return null;

            return parsed;
        } catch {
            return null;
        }
    }

    function writeTurnoverCache(payload: TurnoverPayload) {
        if (payload.error) return;
        try {
            localStorage.setItem(turnoverStorageKey(), JSON.stringify(payload));
        } catch {
            // Ignore quota.
        }
    }

    const turnoverResult = useSWR(
        `ozon-turnover:${clientId}`,
        async (signal) => {
            if (!$ozonKeys.clientId || !$ozonKeys.apiKey) {
                throw new Error(
                    "Укажите Client ID и API Key в настройках (шестерёнка справа сверху).",
                );
            }

            const cached = readTurnoverCache();
            if (cached) {
                const age = Date.now() - Date.parse(cached.fetchedAt);
                if (Number.isFinite(age) && age < TURNOVER_MIN_AGE_MS) return cached;
            }

            const payload = await getTurnoverData(signal);
            writeTurnoverCache(payload);
            return payload;
        },
        { dedupingInterval: 2000, refreshInterval: 60 * 60 * 1000 },
    );

    const {
        data: turnoverData,
        reset: resetTurnover,
        mutate: mutateTurnover,
        dispose: disposeTurnover,
    } = turnoverResult;

    onDestroy(disposeTurnover);

    const turnover = $derived(summariseTurnover($turnoverData?.rows ?? []));

    // Ozon reports turnover by SKU; the names come from the inventory rows.
    const turnoverDeficit = $derived.by(() => {
        const nameBySku = new Map(inventory.rows.map((row) => [row.sku, row.name]));

        return turnover.deficit.slice(0, 8).map((row) => ({
            sku: row.sku,
            name: nameBySku.get(row.sku) ?? `SKU ${row.sku}`,
            idc: row.idc,
            grade: gradeLabel(row.grade),
            cluster: gradeLabel(row.gradeCluster)
        }));
    });

    // --- Capital and priorities ---
    const capital = $derived(
        capitalSummary({
            inventory,
            economics: skuRows,
            unitCost: (offerId, sku) => costs(offerId, sku, new Date()),
            periodDays: MONEY_WINDOW_DAYS
        })
    );

    const actions = $derived(
        buildActions({
            capital,
            economics: skuRows,
            finance,
            costedShare: capital.costedShare,
            soldCostCoverage:
                marginTotals.units > 0 ? marginTotals.costedUnits / marginTotals.units : 0,
            now: new Date()
        })
    );

    const ACTION_SEVERITY_LABELS: Record<string, string> = {
        high: "Срочно",
        medium: "Важно",
        low: "К сведению"
    };

    const ACTION_BASIS_LABELS: Record<string, string> = {
        day: "в день",
        period: "за период",
        once: "заморожено",
        none: ""
    };

    /** Restocking suggestion for the items running out, most urgent first. */
    const RESTOCK_COVER_DAYS = 30;
    const replenishment = $derived(
        capital.rows
            .filter(
                (row) =>
                    row.demandPerDay > 0 &&
                    (row.health === "out" ||
                        row.health === "critical" ||
                        row.health === "low"),
            )
            .map((row) => {
                const unitCost =
                    row.stockUnits > 0 && row.stockAtCost !== null
                        ? row.stockAtCost / row.stockUnits
                        : null;
                const units = suggestedOrder(
                    row.demandPerDay,
                    row.stockUnits,
                    RESTOCK_COVER_DAYS,
                );

                return {
                    key: row.key,
                    name: row.name,
                    stockUnits: row.stockUnits,
                    units,
                    /** What the order costs, when a cost price is known. */
                    money: unitCost === null ? null : units * unitCost
                };
            })
            .filter((row) => row.units > 0)
            .sort((a, b) => (b.money ?? 0) - (a.money ?? 0) || b.units - a.units)
            .slice(0, 6)
    );

    // Products offered in the cost panel: everything that sold in the window.
    const costCandidates = $derived(
        skuRows.map((row) => ({
            key: row.key,
            label: row.name,
            units: row.units,
            payout: row.payout
        })),
    );

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

    const statsConfig = $derived([
        {
            label: "Last 24 Hours",
            value: stats.last24h,
            color: "#6366F1",
            icon: `<path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />`,
        },
        {
            label: "Last 7 Days",
            value: stats.last7d,
            color: "#8B5CF6",
            icon: `<path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />`,
        },
        {
            label: "Last 31 Days",
            value: stats.last31d,
            color: "#EC4899",
            icon: `<path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />`,
        },
        {
            label: "Calendar Day",
            value: stats.calendarDay,
            color: "#F59E0B",
            icon: `<path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707m12.728 12.728L5.636 5.636" />`,
        },
        {
            label: "Calendar Week",
            value: stats.calendarWeek,
            color: "#10B981",
            icon: `<path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0h6v-9a2 2 0 012-2h2a2 2 0 012 2v9m-18 0h18" />`,
        },
        {
            label: "Calendar Month",
            value: stats.calendarMonth,
            color: "#3B82F6",
            icon: `<path d="M21.21 15.89A10 10 0 118 2.83M22 12A10 10 0 0012 2v10h10z" />`,
        },
    ]);
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
    <section class="insights-section" aria-label="Что требует действия">
        <div class="bento-header">
            <h2 class="section-title">Требует действия</h2>
            <InfoTip
                text="Сводка того, что стоит сделать, с суммой на кону. У каждой строки указана своя база: «в день» — теряется ежедневно, «за период» — уже потеряно за 31 день, «заморожено» — деньги, вложенные в товар и не возвращающиеся продажами. Складывать эти числа между собой нельзя."
                label="Пояснение к списку действий"
            />
        </div>

        {#if showSkeletons}
            <div class="action-list" aria-hidden="true">
                {#each [1, 2, 3] as card (card)}
                    <div class="action-card">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-chip"></span>
                    </div>
                {/each}
            </div>
        {:else if actions.length === 0}
            <div class="panel glass-panel state-note">
                <p>Срочного нет: дефицита нет, убыточных товаров нет, начисления свежие.</p>
            </div>
        {:else}
            <div class="action-list">
                {#each actions as action (action.kind)}
                    <div class="action-card" data-severity={action.severity}>
                        <div class="action-main">
                            <span class="action-head">
                                <span class="action-severity" data-severity={action.severity}
                                    >{ACTION_SEVERITY_LABELS[action.severity]}</span
                                >
                                <span class="action-title">{action.title}</span>
                            </span>
                            <span class="action-detail">{action.detail}</span>
                            {#if action.skus.length > 0}
                                <span class="action-skus">
                                    {action.skus.map((item) => item.name).join(" · ")}{action
                                        .skus.length >= 5
                                        ? " и другие"
                                        : ""}
                                </span>
                            {/if}
                        </div>
                        {#if action.amount !== null}
                            <div class="action-amount">
                                <span class="action-value"
                                    >{formatCurrency(action.amount)}</span
                                >
                                <span class="action-basis"
                                    >{ACTION_BASIS_LABELS[action.basis]}</span
                                >
                            </div>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}
    </section>
    <section class="stats-section" aria-busy={showSkeletons}>
        <div class="bento-header">
            <h2 class="section-title">Performance Analytics</h2>
            <InfoTip
                text="Шесть окон сразу: календарные (с 00:00 сегодня, с понедельника, с 1-го числа) и скользящие (последние 24 часа / 7 / 31 день от текущего момента). Большое число в каждой карточке — выручка без отменённых заказов, строка Gross — до вычетов."
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

        <div class="bento-grid">
            {#if showSkeletons}
                <!-- Same six grid children in the same order, so the areas line up. -->
                <div class="bento-card hero-card glass-panel">
                    <span class="skeleton sk-hero"></span>
                    <span class="skeleton sk-line"></span>
                </div>
                <div class="bento-card medium-card glass-panel">
                    <span class="skeleton sk-medium"></span>
                    <span class="skeleton sk-line"></span>
                </div>
                <div class="bento-card medium-card glass-panel">
                    <span class="skeleton sk-medium"></span>
                    <span class="skeleton sk-line"></span>
                </div>
                {#each [1, 2, 3] as card (card)}
                    <div class="bento-card small-card glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-small"></span>
                    </div>
                {/each}
            {:else}
            <!-- Hero Card: Calendar Day -->
            <div class="bento-card hero-card glass-panel glow-effect">
                <div class="card-content">
                    <div class="card-header">
                        <span class="bento-label">Calendar Day</span>
                        <span
                            class="live-indicator"
                            class:busy={$isValidating}
                            class:stale={showingStaleData}
                            aria-hidden="true"
                        ></span>
                    </div>
                    <div class="card-main-value">
                        <span class="currency-symbol">₽</span>
                        <span class="diamond-text text-xl"
                            >{formatCurrencyParts(stats.calendarDay.netSum).amount}</span
                        >
                        <!-- This is the seller's price, i.e. what the buyer pays. It is
                             not what reaches the account; the money block below says
                             how much Ozon keeps. -->
                        <div class="main-label">Выручка продавца · без отмен</div>
                    </div>
                    <div class="card-sub-stats">
                        <div class="sub-stat">
                            <span class="sub-label">С отменами</span>
                            <span class="sub-value"
                                >{formatCurrency(stats.calendarDay.sum)}</span
                            >
                        </div>
                        <div class="separator"></div>
                        <div class="sub-stat">
                            <span class="sub-label">Orders</span>
                            <span class="sub-value"
                                >{stats.calendarDay.count}</span
                            >
                        </div>
                        {#if stats.calendarDay.cancelled > 0}
                            <div class="separator"></div>
                            <div class="sub-stat">
                                <span class="sub-label text-error"
                                    >Cancelled</span
                                >
                                <span class="sub-value text-error">
                                    {stats.calendarDay.cancelled} ({formatCurrency(
                                        stats.calendarDay.cancelledSum,
                                    )})
                                </span>
                            </div>
                        {/if}
                    </div>
                </div>
            </div>

            <!-- Medium Card: Calendar Week -->
            <div class="bento-card medium-card glass-panel">
                <div class="card-content">
                    <span class="bento-label">Calendar Week</span>
                    <div class="card-value-group">
                        <!-- Main: Net Sales -->
                        <span class="diamond-text text-lg"
                            >{formatCurrencyParts(stats.calendarWeek.netSum).amount}</span
                        >
                        <span class="unit">₽</span>
                    </div>
                    <div class="mini-stat-col">
                        <div class="mini-row">
                            <span class="mini-label">Orders:</span>
                            <span class="mini-value"
                                >{stats.calendarWeek.count}</span
                            >
                        </div>
                        <div class="mini-row">
                            <span class="mini-label">Gross (с отменами):</span>
                            <span class="mini-value"
                                >{formatCurrency(stats.calendarWeek.sum)}</span
                            >
                        </div>
                        {#if stats.calendarWeek.cancelled > 0}
                            <div class="mini-row">
                                <span class="mini-label text-error"
                                    >Cancelled:</span
                                >
                                <span class="mini-value text-error">
                                    {stats.calendarWeek.cancelled} ({formatCurrency(
                                        stats.calendarWeek.cancelledSum,
                                    )})
                                </span>
                            </div>
                        {/if}
                    </div>
                </div>
            </div>

            <!-- Medium Card: Calendar Month -->
            <div class="bento-card medium-card glass-panel">
                <div class="card-content">
                    <span class="bento-label">Calendar Month</span>
                    <div class="card-value-group">
                        <span class="diamond-text text-lg"
                            >{formatCurrencyParts(stats.calendarMonth.netSum).amount}</span
                        >
                        <span class="unit">₽</span>
                    </div>
                    <div class="mini-stat-col">
                        <div class="mini-row">
                            <span class="mini-label">Orders:</span>
                            <span class="mini-value"
                                >{stats.calendarMonth.count}</span
                            >
                        </div>
                        <div class="mini-row">
                            <span class="mini-label">Gross (с отменами):</span>
                            <span class="mini-value"
                                >{formatCurrency(stats.calendarMonth.sum)}</span
                            >
                        </div>
                        {#if stats.calendarMonth.cancelled > 0}
                            <div class="mini-row">
                                <span class="mini-label text-error"
                                    >Cancelled:</span
                                >
                                <span class="mini-value text-error">
                                    {stats.calendarMonth.cancelled} ({formatCurrency(
                                        stats.calendarMonth.cancelledSum,
                                    )})
                                </span>
                            </div>
                        {/if}
                    </div>
                </div>
            </div>

            <!-- Small Cards (Optimized for space) -->
            <div class="bento-card small-card glass-panel">
                <span class="bento-label small">Last 24 Hours</span>
                <div class="small-value">
                    <span class="diamond-text text-md"
                        >{formatCurrencyParts(stats.last24h.netSum).amount}</span
                    >
                </div>
                <div class="micro-stat-group">
                    <div class="micro-stat">
                        Orders: {stats.last24h.count}
                    </div>
                    <div class="micro-stat">
                        Gross (с отменами): {formatCurrency(stats.last24h.sum)}
                    </div>
                    {#if stats.last24h.cancelled > 0}
                        <div class="micro-stat text-error">
                            -{formatCurrency(stats.last24h.cancelledSum)} ({stats
                                .last24h.cancelled})
                        </div>
                    {/if}
                </div>
            </div>

            <div class="bento-card small-card glass-panel">
                <span class="bento-label small">Last 7 Days</span>
                <div class="small-value">
                    <span class="diamond-text text-md"
                        >{formatCurrencyParts(stats.last7d.netSum).amount}</span
                    >
                </div>
                <div class="micro-stat-group">
                    <div class="micro-stat">
                        Orders: {stats.last7d.count}
                    </div>
                    <div class="micro-stat">
                        Gross (с отменами): {formatCurrency(stats.last7d.sum)}
                    </div>
                    {#if stats.last7d.cancelled > 0}
                        <div class="micro-stat text-error">
                            -{formatCurrency(stats.last7d.cancelledSum)} ({stats
                                .last7d.cancelled})
                        </div>
                    {/if}
                </div>
            </div>

            <div class="bento-card small-card glass-panel">
                <span class="bento-label small">Last 31 Days</span>
                <div class="small-value">
                    <span class="diamond-text text-md"
                        >{formatCurrencyParts(stats.last31d.netSum).amount}</span
                    >
                </div>
                <div class="micro-stat-group">
                    <div class="micro-stat">
                        Orders: {stats.last31d.count}
                    </div>
                    <div class="micro-stat">
                        Gross (с отменами): {formatCurrency(stats.last31d.sum)}
                    </div>
                    {#if stats.last31d.cancelled > 0}
                        <div class="micro-stat text-error">
                            -{formatCurrency(stats.last31d.cancelledSum)} ({stats
                                .last31d.cancelled})
                        </div>
                    {/if}
                </div>
            </div>
            {/if}
        </div>
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Деньги · последние 31 день</h2>
            <InfoTip
                text="Что из выручки забирает Ozon и что остаётся продавцу. Комиссия и её фактическая ставка — из финансовых данных заказа, это точные суммы. «Остаётся продавцу» — payout из карточки заказа (цена минус комиссия); логистика, обработка отправления и эквайринг в него могут не входить, поэтому это ещё не сумма к выплате на счёт. Точное «к перечислению» появится, когда подключим финансовый слой Ozon. Отменённые заказы не учитываются."
                label="Пояснение к деньгам"
            />
        </div>
        <div class="kpi-strip">
            {#if showSkeletons}
                {#each [1, 2, 3, 4, 5, 6] as chip (chip)}
                    <div class="kpi-chip glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-chip"></span>
                    </div>
                {/each}
            {:else}
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Выручка продавца</span>
                    <span class="kpi-value">{formatCurrency(money.gross)}</span>
                    <span class="kpi-delta">цена покупателя, без отмен</span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Комиссия Ozon</span>
                    <span class="kpi-value">{formatCurrency(money.commission)}</span>
                    <span class="kpi-delta"
                        >факт. ставка
                        {money.commissionRate === null
                            ? "—"
                            : formatPercent(money.commissionRate * 100)}</span
                    >
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Остаётся продавцу</span>
                    <span class="kpi-value">{formatCurrency(money.payout)}</span>
                    <span class="kpi-delta"
                        >{money.payoutRatio === null
                            ? "—"
                            : formatPercent(money.payoutRatio * 100)} от выручки</span
                    >
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Отдано скидками</span>
                    <span class="kpi-value"
                        >{formatCurrency(money.discountValue)}</span
                    >
                    <span class="kpi-delta">относительно старой цены</span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Продано штук</span>
                    <span class="kpi-value">{formatNumber(money.units)}</span>
                </div>
                {#if money.complete}
                    <div class="kpi-chip glass-panel">
                        <span class="kpi-label">Финансовые данные</span>
                        <span class="kpi-value">{money.reportedLines}</span>
                        <span class="kpi-delta">по всем строкам заказов</span>
                    </div>
                {:else}
                    <div class="kpi-chip glass-panel alert">
                        <span class="kpi-label">Финансовые данные</span>
                        <span class="kpi-value"
                            >{money.reportedLines} из {money.totalLines}</span
                        >
                        <span class="kpi-delta"
                            >Ozon отдал суммы не по всем строкам — доли считаются
                            только по ним</span
                        >
                    </div>
                {/if}
            {/if}
        </div>
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Начисления Ozon · последние 31 день</h2>
            <InfoTip
                text="Это то, что Ozon начислил и удержал по каждому отправлению — единственный источник, по которому видно, сколько денег реально дойдёт до счёта. Сумма берётся из total_amount как есть и никогда не пересчитывается из комиссии и услуг: у штрафов, страховки и компенсаций отдельных строк нет. Расходы кабинета (хранение, продвижение, сбор отзывов) показаны отдельно и не размазаны по заказам — иначе цифра по отправлению перестала бы сходиться с кабинетом."
                label="Пояснение к начислениям"
            />
            {#if !$financeLoading && finance.failedDays.length === 0 && finance.lastDayWithData}
                <span class="freshness" role="status" aria-live="polite">
                    данные по {finance.lastDayWithData}
                </span>
            {/if}
        </div>

        {#if $financeLoading}
            <div class="kpi-strip" aria-hidden="true">
                {#each [1, 2, 3, 4] as chip (chip)}
                    <div class="kpi-chip glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-chip"></span>
                    </div>
                {/each}
            </div>
            <p class="muted-note">
                Финансовый слой читается по одному дню за запрос, поэтому первый раз это
                занимает несколько секунд. Дальше закрытые дни берутся из кэша браузера.
            </p>
        {:else if financeLoadError}
            <div class="panel glass-panel state-note" role="alert">
                <p>Начисления не загрузились: {financeLoadError}</p>
                <button
                    type="button"
                    class="btn-inline"
                    onclick={() => mutateFinance({ force: true })}
                    disabled={$financeValidating}
                >
                    {$financeValidating ? "Обновляем…" : "Повторить"}
                </button>
            </div>
        {:else}
            <div class="kpi-strip">
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">К получению по заказам</span>
                    <span class="kpi-value">{formatCurrency(finance.netOrders)}</span>
                    <span class="kpi-delta">{finance.accrualCount} начислений</span>
                </div>
                <div class="kpi-chip glass-panel" class:alert={finance.netCabinet < 0}>
                    <span class="kpi-label">Расходы кабинета</span>
                    <span class="kpi-value">{formatCurrency(finance.netCabinet)}</span>
                    <span class="kpi-delta">хранение, продвижение, прочее</span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Итого за период</span>
                    <span class="kpi-value">{formatCurrency(finance.net)}</span>
                    <span class="kpi-delta">то, что дойдёт до счёта</span>
                </div>
                <div class="kpi-chip glass-panel" class:alert={finance.failedDays.length > 0}>
                    <span class="kpi-label">Дней с данными</span>
                    <span class="kpi-value">{finance.daysWithData}</span>
                    <span class="kpi-delta">
                        {#if finance.failedDays.length > 0}
                            {finance.failedDays.length} дн. не загрузилось — в итог не вошли
                        {:else if finance.emptyDays.length > 0}
                            {finance.emptyDays.length} дн. без начислений
                        {:else}
                            все дни периода
                        {/if}
                    </span>
                </div>
            </div>

            {#if finance.failedDays.length > 0}
                <div class="panel glass-panel state-note" role="alert">
                    <p>
                        Часть дней не загрузилась, и в суммы они не подставлены нулём:
                        {finance.failedDays
                            .slice(0, 3)
                            .map((day) => day.date)
                            .join(", ")}{finance.failedDays.length > 3
                            ? ` и ещё ${finance.failedDays.length - 3}`
                            : ""}.
                    </p>
                    <p class="muted-note">
                        {finance.failedDays[0]?.error ?? ""}
                    </p>
                </div>
            {/if}

            <div class="breakdown-grid">
                <div class="panel glass-panel">
                    <span class="panel-title-row">
                        <h3 class="panel-title">Из чего складывается по заказам</h3>
                        <InfoTip
                            text="Удержания, привязанные к отправлениям, сгруппированные по смыслу. Сумма строк не равна итогу: итог берётся из начислений как есть, а здесь показано, из чего он состоит."
                            label="Пояснение к удержаниям"
                        />
                    </span>
                    {#if financeGroups.length === 0}
                        <p class="muted-note">Нет начислений за период.</p>
                    {:else}
                        <div class="mini-list">
                            {#each financeGroups as row (row.group)}
                                <div class="mini-row">
                                    <span class="mini-name"
                                        >{FEE_GROUP_LABELS[row.group]}</span
                                    >
                                    <span class="mini-value"
                                        >{formatCurrency(row.amount)}</span
                                    >
                                </div>
                            {/each}
                        </div>
                    {/if}
                </div>

                <div class="panel glass-panel">
                    <span class="panel-title-row">
                        <h3 class="panel-title">Расходы кабинета по видам</h3>
                        <InfoTip
                            text="Начисления без номера отправления: хранение, продвижение, сбор отзывов и прочее. Они относятся к кабинету целиком, поэтому не размазываются по заказам."
                            label="Пояснение к расходам кабинета"
                        />
                    </span>
                    {#if finance.cabinetLines.length === 0}
                        <p class="muted-note">Расходов кабинета за период нет.</p>
                    {:else}
                        <div class="mini-list">
                            {#each finance.cabinetLines as line (line.key)}
                                <div class="mini-row">
                                    <span class="mini-name" title={line.label}
                                        >{line.label}</span
                                    >
                                    <span class="mini-value"
                                        >{formatCurrency(line.amount)}</span
                                    >
                                </div>
                            {/each}
                        </div>
                    {/if}
                </div>

                {#if finance.orderLines.length > 0}
                    <div class="panel glass-panel">
                        <span class="panel-title-row">
                            <h3 class="panel-title">Все удержания по типам</h3>
                            <InfoTip
                                text="Полный список типов начислений с суммами. Названия приходят из справочника Ozon; если название неизвестно, показывается идентификатор типа, а не выдуманная подпись."
                                label="Пояснение к типам начислений"
                            />
                        </span>
                        <div class="mini-list">
                            {#each finance.orderLines.slice(0, 12) as line (line.key)}
                                <div class="mini-row">
                                    <span class="mini-name" title={line.label}
                                        >{line.label}</span
                                    >
                                    <span class="mini-value"
                                        >{formatCurrency(line.amount)}</span
                                    >
                                </div>
                            {/each}
                        </div>
                    </div>
                {/if}
            </div>
        {/if}
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Маржа и ассортимент · последние 31 день</h2>
            <InfoTip
                text="Маржа считается как «остаётся продавцу» минус себестоимость проданных штук. Себестоимость Ozon не знает и не отдаёт — её задаёт продавец, и она хранится в этом браузере. Пока себестоимость известна не по всем штукам, прибыль по товару не показывается: подставить ноль значило бы выдать отсутствие данных за убыток. ABC-разбор идёт по прибыли, когда она известна, и по остатку продавцу, пока нет."
                label="Пояснение к марже"
            />
            <button
                type="button"
                class="btn-inline"
                onclick={() => (showCogs = true)}
            >
                Себестоимость ({marginTotals.covered}/{marginTotals.total})
            </button>
        </div>

        <div class="kpi-strip">
            {#if showSkeletons}
                {#each [1, 2, 3, 4] as chip (chip)}
                    <div class="kpi-chip glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-chip"></span>
                    </div>
                {/each}
            {:else if !marginTotals.hasAnyCost}
                <div class="panel glass-panel state-note">
                    <p>
                        Себестоимость не задана, поэтому прибыль и маржа не считаются.
                        Выручка, комиссия и остаток продавцу выше — настоящие, они
                        приходят из Ozon.
                    </p>
                    <button
                        type="button"
                        class="btn-inline"
                        onclick={() => (showCogs = true)}
                    >
                        Задать себестоимость
                    </button>
                </div>
            {:else}
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Валовая прибыль</span>
                    <span class="kpi-value">{formatCurrency(marginTotals.profit)}</span>
                    <span class="kpi-delta"
                        >по {marginTotals.covered} из {marginTotals.total} SKU</span
                    >
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Маржа</span>
                    <span class="kpi-value"
                        >{marginTotals.marginPercent === null
                            ? "—"
                            : formatPercent(marginTotals.marginPercent)}</span
                    >
                    <span class="kpi-delta">от остатка продавцу</span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Себестоимость продаж</span>
                    <span class="kpi-value"
                        >{formatCurrency(
                            marginTotals.payout - marginTotals.profit,
                        )}</span
                    >
                    <span class="kpi-delta">по покрытым SKU</span>
                </div>
                <div class="kpi-chip glass-panel" class:alert={losers.length > 0}>
                    <span class="kpi-label">Продаются в минус</span>
                    <span class="kpi-value">{losers.length}</span>
                    <span class="kpi-delta"
                        >{marginTotals.costedUnits < marginTotals.units
                            ? `себестоимость известна для ${Math.round(marginTotals.costedUnits)} из ${marginTotals.units} шт`
                            : "по всем проданным штукам"}</span
                    >
                </div>
            {/if}
        </div>

        {#if !showSkeletons && marginTotals.hasAnyCost}
            <div class="panel glass-panel">
                <div class="panel-head">
                    <span class="panel-title-group">
                        <h3 class="panel-title">
                            ABC по {abcUsesProfit ? "прибыли" : "остатку продавцу"}
                        </h3>
                        <InfoTip
                            text="Класс A — товары, дающие первые 80% результата, B — следующие 15%, C — остаток. Когда себестоимость известна, результат — это прибыль; иначе это остаток продавцу после комиссии."
                            label="Пояснение к ABC"
                        />
                    </span>
                    <div class="panel-controls">
                        <span class="panel-note"
                            >A {abcCounts.A} · B {abcCounts.B} · C {abcCounts.C}</span
                        >
                    </div>
                </div>
                {#if abc.length === 0}
                    <p class="muted-note">Нет данных за период.</p>
                {:else}
                    <div class="mini-list">
                        {#each abc.slice(0, 8) as row (row.key)}
                            <div class="mini-row">
                                <span class="mini-name" title={row.label}>
                                    <span class="abc-badge" data-grade={row.grade}
                                        >{row.grade}</span
                                    >
                                    {row.label}
                                </span>
                                <span class="mini-value"
                                    >{formatCurrency(row.value)} · {formatPercent(
                                        row.share,
                                    )}</span
                                >
                            </div>
                            <div
                                class="mini-bar"
                                style="width: {Math.max(2, Math.round(row.share))}%"
                            ></div>
                        {/each}
                    </div>
                {/if}
            </div>
        {/if}

        {#if !showSkeletons && losers.length > 0}
            <div class="panel glass-panel loss-panel">
                <div class="panel-head">
                    <span class="panel-title-group">
                        <h3 class="panel-title">Продаются ниже себестоимости</h3>
                        <InfoTip
                            text="Эти товары приносят меньше, чем стоит их закупка. «Безубыточная цена» — цена, при которой товар перестанет терять деньги при текущей доле, остающейся продавцу."
                            label="Пояснение к убыточным товарам"
                        />
                    </span>
                </div>
                <div class="loss-list">
                    {#each losers as row (row.key)}
                        <div class="loss-row">
                            <span class="loss-name" title={row.name}>{row.name}</span>
                            <span class="loss-money">
                                <span class="loss-value"
                                    >{formatCurrency(row.grossProfit ?? 0)}</span
                                >
                                <span class="loss-detail">
                                    {row.units} шт · закупка
                                    {formatCurrency(row.unitCost ?? 0)}/шт
                                    {#if row.breakEven !== null}
                                        · безубыток от
                                        {formatCurrency(row.breakEven)}
                                    {/if}
                                </span>
                            </span>
                        </div>
                    {/each}
                </div>
            </div>
        {/if}
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Капитал и оборачиваемость</h2>
            <InfoTip
                text="Сколько денег вложено в товар на складе и как быстро они возвращаются. Запас в закупке — это оборотный капитал по вашей себестоимости, а не по цене продажи. Оборачиваемость и GMROI считаются от текущей стоимости запаса, потому что истории остатков мы пока не храним, — при ровном складе это близко к среднему. Упускается в день: товар продаётся, но его нет на складе, поэтому каждая строка показывает потерю за сутки, а не выдуманный итог за неизвестный срок простоя."
                label="Пояснение к капиталу"
            />
        </div>

        {#if showSkeletons}
            <div class="kpi-strip" aria-hidden="true">
                {#each [1, 2, 3, 4] as chip (chip)}
                    <div class="kpi-chip glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-chip"></span>
                    </div>
                {/each}
            </div>
        {:else}
            <div class="kpi-strip">
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
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">GMROI</span>
                    <span class="kpi-value"
                        >{capital.gmroi === null
                            ? "—"
                            : formatPercent(capital.gmroi, 0)}</span
                    >
                    <span class="kpi-delta">валовая прибыль на рубль запаса</span>
                </div>
                <div class="kpi-chip glass-panel" class:alert={capital.lostRows.length > 0}>
                    <span class="kpi-label">Упускается в день</span>
                    <span class="kpi-value"
                        >{formatCurrency(
                            capital.lostProfitPerDay ?? capital.lostRevenuePerDay,
                        )}</span
                    >
                    <span class="kpi-delta">
                        {#if capital.lostRows.length === 0}
                            нет товаров в дефиците со спросом
                        {:else if capital.lostProfitPerDay === null}
                            выручка · {capital.lostRows.length} SKU в дефиците
                        {:else}
                            маржа · {capital.lostRows.length} SKU в дефиците
                        {/if}
                    </span>
                </div>
                <div class="kpi-chip glass-panel" class:alert={capital.frozenSkus > 0}>
                    <span class="kpi-label">Заморожено в неликвиде</span>
                    <span class="kpi-value"
                        >{capital.frozenAtCost === null
                            ? `${formatNumber(capital.frozenUnits)} шт`
                            : formatCurrency(capital.frozenAtCost)}</span
                    >
                    <span class="kpi-delta"
                        >{capital.frozenSkus} SKU · {formatNumber(
                            capital.frozenUnits,
                        )} шт</span
                    >
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Sell-through</span>
                    <span class="kpi-value"
                        >{capital.sellThrough === null
                            ? "—"
                            : formatPercent(capital.sellThrough, 0)}</span
                    >
                    <span class="kpi-delta">продано от проданного и лежащего</span>
                </div>
            </div>

            {#if replenishment.length > 0}
                <div class="panel glass-panel">
                    <div class="panel-head">
                        <span class="panel-title-group">
                            <h3 class="panel-title">Что заказать · запас на 30 дней</h3>
                            <InfoTip
                                text="Количество считается по наблюдённому темпу продаж: сколько нужно, чтобы закрыть 30 дней, минус то, что уже лежит на складе. Это оценка по прошлому спросу, а не гарантия продаж."
                                label="Пояснение к закупке"
                            />
                        </span>
                    </div>
                    <div class="mini-list">
                        {#each replenishment as row (row.key)}
                            <div class="mini-row">
                                <span class="mini-name" title={row.name}>{row.name}</span>
                                <span class="mini-value"
                                    >{row.stockUnits} шт → заказать {row.units} шт{#if row.money !== null}
                                        · {formatCurrency(row.money)}{/if}</span
                                >
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}

            {#if capital.lostRows.length > 0}
                <div class="panel glass-panel loss-panel">
                    <div class="panel-head">
                        <span class="panel-title-group">
                            <h3 class="panel-title">Дефицит со спросом</h3>
                            <InfoTip
                                text="Товар продавался, но сейчас его нет на складе. Сумма — потеря за одни сутки при текущем темпе продаж. Сколько именно длится простой, из данных не видно, поэтому итог за период не выдумывается."
                                label="Пояснение к дефициту"
                            />
                        </span>
                    </div>
                    <div class="loss-list">
                        {#each capital.lostRows.slice(0, 10) as row (row.key)}
                            <div class="loss-row">
                                <span class="loss-name" title={row.name}>{row.name}</span>
                                <span class="loss-money">
                                    <span class="loss-value"
                                        >{formatCurrency(
                                            row.dailyLostProfit ?? row.dailyLostRevenue,
                                        )}/день</span
                                    >
                                    <span class="loss-detail">
                                        {row.demandPerDay.toFixed(1).replace(".", ",")} шт/день
                                        {#if row.dailyLostProfit === null}
                                            · упущенная выручка
                                        {:else}
                                            · упущенная маржа
                                        {/if}
                                    </span>
                                </span>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}
            {#if turnoverDeficit.length > 0}
                <div class="panel glass-panel">
                    <div class="panel-head">
                        <span class="panel-title-group">
                            <h3 class="panel-title">Дефицит по расчёту Ozon</h3>
                            <InfoTip
                                text="Оборачиваемость считает сам Ozon — по своей модели спроса, отдельно по каждому SKU. Здесь только те товары, которые Ozon помечает как дефицитные, с его оценкой запаса в днях. Метод доступен не чаще одного запроса в минуту, поэтому данные берутся из кэша браузера и обновляются редко."
                                label="Пояснение к оборачиваемости Ozon"
                            />
                        </span>
                        <div class="panel-controls">
                            <span class="panel-note">
                                {turnover.deficit.length} в дефиците
                                {#if $turnoverData?.truncated}
                                    · Ozon вернул не все строки
                                {/if}
                            </span>
                        </div>
                    </div>
                    <div class="mini-list">
                        {#each turnoverDeficit as row (row.sku)}
                            <div class="mini-row">
                                <span class="mini-name" title={row.name}>{row.name}</span>
                                <span class="mini-value">
                                    {row.grade ?? "без оценки"}{#if row.idc !== null}
                                        · {row.idc.toFixed(0)} дн.{/if}
                                    {#if row.cluster}· {row.cluster}{/if}
                                </span>
                            </div>
                        {/each}
                    </div>
                </div>
            {:else if $turnoverData?.error}
                <p class="muted-note">
                    Оборачиваемость Ozon недоступна: {$turnoverData.error}
                </p>
            {/if}
        {/if}
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Ключевые показатели · текущий месяц</h2>
            <InfoTip
                text="Производные показатели за текущий календарный месяц: средний чек, доля отмен, штук в заказе, средняя цена, проданные штуки и число кросс-кластерных отправлений. Два последних чипа — скользящие окна 24 часа и 7 дней (не календарные) и тоже без отмен, чтобы сравнивать с главным числом дашборда."
                label="Пояснение к ключевым показателям"
            />
        </div>
        <div class="kpi-strip">
            {#if showSkeletons}
                {#each [1, 2, 3, 4, 5, 6, 7, 8] as chip (chip)}
                    <div class="kpi-chip glass-panel">
                        <span class="skeleton sk-line"></span>
                        <span class="skeleton sk-chip"></span>
                    </div>
                {/each}
            {:else}
                {#each derivedMetrics as metric (metric.label)}
                    <div class="kpi-chip glass-panel">
                        <span class="kpi-label">{metric.label}</span>
                        <span class="kpi-value">{metric.value}</span>
                    </div>
                {/each}
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Выручка продавца · 24ч</span>
                    <span class="kpi-value"
                        >{formatCurrency(deltas.last24h.netRevenue)}</span
                    >
                    <span
                        class="kpi-delta"
                        class:positive={isUp(deltas.last24h.netRevenueChangePct)}
                        class:negative={isDown(deltas.last24h.netRevenueChangePct)}
                        >{formatDelta(deltas.last24h.netRevenueChangePct)} к
                        предыдущим 24ч</span
                    >
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Выручка продавца · 7 дней</span>
                    <span class="kpi-value"
                        >{formatCurrency(deltas.last7d.netRevenue)}</span
                    >
                    <span
                        class="kpi-delta"
                        class:positive={isUp(deltas.last7d.netRevenueChangePct)}
                        class:negative={isDown(deltas.last7d.netRevenueChangePct)}
                        >{formatDelta(deltas.last7d.netRevenueChangePct)} к
                        предыдущим 7 дням</span
                    >
                </div>
            {/if}
        </div>

        <div class="panel glass-panel trend-panel">
            <div class="panel-head">
                <span class="panel-title-group">
                    <h3 class="panel-title">Тренд выручки продавца · {windowDays} дн.</h3>
                    <InfoTip
                        text="Цена продавца по дням за выбранное окно (без отменённых заказов) — это деньги покупателя, а не поступление на счёт. Окно 7/14/31 дня задаётся переключателем справа и общее для тренда и графика по часам."
                        label="Пояснение к тренду выручки"
                    />
                </span>
                <div class="panel-controls">
                    <span class="panel-note">максимум {formatCurrency(trendMax)} в день</span>
                    <RangeToggle bind:value={windowDays} />
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
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Разрезы продаж</h2>
            <InfoTip
                text="Разбивка продаж за последние 31 день по разным срезам. Во всех разрезах отменённые заказы не учитываются."
                label="Пояснение к разрезам продаж"
            />
        </div>

        <div class="panel glass-panel hour-panel">
            <div class="panel-head">
                <span class="panel-title-group">
                    <h3 class="panel-title">Когда покупают · по часам ({windowDays} дн.)</h3>
                    <InfoTip
                        text="Распределение заказов по часам суток за выбранное окно (местное время). Окно 7/14/31 дня — общий переключатель с трендом выше. Самый активный час выделен золотым."
                        label="Пояснение к разрезу по часам"
                    />
                </span>
                <div class="panel-controls">
                    <span class="panel-note">
                        пик {pad(peakHour.hour)}:00–{pad((peakHour.hour + 1) % 24)}:00 ·
                        {peakHour.orders} заказов
                    </span>
                    <RangeToggle bind:value={windowDays} />
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

        <div class="breakdown-grid">
            <div class="panel glass-panel">
                <span class="panel-title-row">
                    <h3 class="panel-title">Топ товаров</h3>
                    <InfoTip
                        text="Товары с наибольшей выручкой за 31 день. Под названием — артикул и SKU, чтобы различать одинаковые по названию варианты; клик открывает товар в остатках. Ниже — какая доля всей выручки приходится на верхушку ассортимента (топ-20% SKU)."
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
                    <h3 class="panel-title">География</h3>
                    <InfoTip
                        text="Выручка по городам доставки (analytics_data.city) за 31 день. Процент — доля города в общей выручке."
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
                    <h3 class="panel-title">Способ оплаты</h3>
                    <InfoTip
                        text="Выручка по группам способов оплаты (analytics_data.payment_type_group_name) за 31 день."
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
                    <h3 class="panel-title">Маршруты кластеров</h3>
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
                    <h3 class="panel-title">Акции и теги</h3>
                    <InfoTip
                        text="Заказы, у которых в financial_data есть теги/акции, и их доля от всех заказов за 31 день."
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

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Остатки и оборачиваемость</h2>
            <InfoTip
                text="Сопоставление продаж за 14 дней с текущими остатками. «Продаж/день» — средний спрос в штуках, «Хватит на» — на сколько дней хватит склада при этом темпе (запас в днях)."
                label="Пояснение к остаткам и оборачиваемости"
            />
        </div>

        {#if stocksLoadingNow}
            <div class="kpi-strip" aria-hidden="true">
                {#each [1, 2, 3, 4, 5, 6] as chip (chip)}
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
                <div class="kpi-chip glass-panel alert">
                    <span class="kpi-label">Нет в наличии</span>
                    <span class="kpi-value">{inventory.outOfStock.length}</span>
                </div>
                <div class="kpi-chip glass-panel alert">
                    <span class="kpi-label">Критично</span>
                    <span class="kpi-value">{inventory.critical.length}</span>
                </div>
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">Без продаж</span>
                    <span class="kpi-value">{inventory.dead.length}</span>
                </div>
            </div>
        {/if}
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Статусы заказов · 7 / 14 / 31 день</h2>
            <InfoTip
                text="Сколько заказов каждого статуса пришло за последние 7, 14 и 31 день. Окна вложенные: заказ за последние 7 дней входит и в 14, и в 31. Отменённые заказы тоже учтены."
                label="Пояснение к статусам заказов"
            />
        </div>

        <div class="panel glass-panel">
            {#if statuses.rows.length === 0}
                <p class="muted-note">За период нет заказов.</p>
            {:else}
                <div class="status-legend">
                    {#each statuses.windows as window, index (window)}
                        <span class="legend-item">
                            <span
                                class="legend-dot"
                                style="background: {seriesColor(index)}"
                            ></span>
                            {window} дн.
                        </span>
                    {/each}
                </div>

                <div class="status-chart">
                    {#each statuses.rows as row (row.status)}
                        <div class="status-row">
                            <span class="status-label" title={statusLabel(row.status)}
                                >{statusLabel(row.status)}</span
                            >
                            <div class="status-bars">
                                {#each row.counts as count, index}
                                    <div class="status-bar-cell">
                                        <div class="bar-track">
                                            <div
                                                class="bar-fill"
                                                style="width: {Math.round(
                                                    (count / statusMax) * 100,
                                                )}%; background: {seriesColor(index)}"
                                            ></div>
                                        </div>
                                        <span class="bar-count">{formatNumber(count)}</span>
                                    </div>
                                {/each}
                            </div>
                        </div>
                    {/each}

                    <div class="status-row total-row">
                        <span class="status-label">Всего заказов</span>
                        <div class="status-bars">
                            {#each statuses.totals as total}
                                <div class="status-bar-cell">
                                    <div class="bar-track"></div>
                                    <span class="bar-count total">{formatNumber(total)}</span>
                                </div>
                            {/each}
                        </div>
                    </div>
                </div>
            {/if}
        </div>
    </section>

    <section class="details-section">
        <div class="card glass full-width">
            <div class="section-header">
                <h2>Recent FBO Orders</h2>
                <div class="pagination">
                    <button
                        class="btn-page"
                        disabled={currentPage === 1}
                        onclick={() => currentPage--}>Prev</button
                    >
                    <span class="page-info"
                        >Page {currentPage} of {totalPages || 1}</span
                    >
                    <button
                        class="btn-page"
                        disabled={currentPage >= totalPages}
                        onclick={() => currentPage++}>Next</button
                    >
                </div>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th style="width: 60px;">Image</th>
                            <th>Product</th>
                            <th>Цена → продавцу</th>
                            <th>Status</th>
                            <th>Payment</th>
                            <th>Route</th>
                            <th>Tags</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#if $isLoading}
                            {#each Array(5) as _}
                                <tr>
                                    {#each Array(8) as __}
                                        <td><span class="skeleton"></span></td>
                                    {/each}
                                </tr>
                            {/each}
                        {:else if paginatedPostings.length > 0}
                            {#each paginatedPostings as posting (posting.posting_number)}
                                {@const rowMoney = rowMoneyByPosting.get(
                                    posting.posting_number,
                                )}
                                {#each posting.products as product, i (`${product.sku || product.name}-${i}`)}
                                    <tr>
                                        {#if i === 0}
                                            <td
                                                rowspan={posting.products
                                                    .length}
                                                class="date-cell"
                                            >
                                                {new Date(
                                                    posting.created_at,
                                                ).toLocaleString("ru-RU", {
                                                    day: "2-digit",
                                                    month: "2-digit",
                                                    hour: "2-digit",
                                                    minute: "2-digit",
                                                })}
                                            </td>
                                        {/if}
                                        <td>
                                            <div
                                                class="product-image-container small"
                                            >
                                                {#if $dashboardData?.skuToImage?.[product.sku]}
                                                    <img
                                                        src={$dashboardData
                                                            .skuToImage[
                                                            product.sku
                                                        ]}
                                                        alt={product.name}
                                                        class="product-thumb"
                                                        width="48"
                                                        height="48"
                                                        loading="lazy"
                                                        decoding="async"
                                                    />
                                                {:else}
                                                    <div
                                                        class="product-thumb-placeholder"
                                                    >
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
                                                            /><polyline
                                                                points="21 15 16 10 5 21"
                                                            /></svg
                                                        >
                                                    </div>
                                                {/if}
                                            </div>
                                        </td>
                                        <td class="name-cell">
                                            <a
                                                href="/stocks?highlight={product.sku}"
                                                class="product-link"
                                            >
                                                {product.name}
                                            </a>
                                            <div class="id-label">
                                                SKU: {product.sku}
                                            </div>
                                        </td>
                                        <td class="price-cell">
                                            {#if rowMoney?.[i]?.payout != null}
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
                                                <div class="id-label">
                                                    комиссия
                                                    {formatCurrency(
                                                        rowMoney[i].commission ?? 0,
                                                    )}{rowMoney[i].commissionPercent !=
                                                    null
                                                        ? ` · ${formatPercent(rowMoney[i].commissionPercent ?? 0)}`
                                                        : ""}
                                                </div>
                                            {:else}
                                                {formatCurrency(
                                                    productUnitPrice(product) *
                                                        (product.quantity || 1),
                                                )}
                                                <div class="id-label">
                                                    Ozon не отдал суммы по этой строке
                                                </div>
                                            {/if}
                                        </td>
                                        {#if i === 0}
                                            <td
                                                rowspan={posting.products
                                                    .length}
                                            >
                                                <span
                                                    class="status-pill"
                                                    data-status={posting.status}
                                                    >{posting.status}</span
                                                >
                                            </td>
                                            <td
                                                rowspan={posting.products
                                                    .length}
                                                class="small-text"
                                                >{posting.analytics_data
                                                    ?.payment_type_group_name ||
                                                    "—"}</td
                                            >
                                            <td
                                                rowspan={posting.products
                                                    .length}
                                                class="small-text"
                                            >
                                                <div
                                                    class="route-info"
                                                    class:is-cross-cluster={posting
                                                        .financial_data
                                                        ?.cluster_from !==
                                                        posting.financial_data
                                                            ?.cluster_to}
                                                >
                                                    <span
                                                        >{posting.financial_data
                                                            ?.cluster_from ||
                                                            "—"}</span
                                                    >
                                                    <span class="arrow-icon"
                                                        >→</span
                                                    >
                                                    <span
                                                        >{posting.financial_data
                                                            ?.cluster_to || "—"}
                                                        <small
                                                            style="opacity: 0.5; font-size: 0.8em;"
                                                            >({posting
                                                                .analytics_data
                                                                ?.city ||
                                                                "—"})</small
                                                        ></span
                                                    >
                                                </div>
                                            </td>
                                            <td
                                                rowspan={posting.products
                                                    .length}
                                            >
                                                <div class="actions-list">
                                                    {#if posting.actions.length > 0}
                                                        {#each posting.actions as action}
                                                            <span
                                                                class="action-tag"
                                                                >{action}</span
                                                            >
                                                        {/each}
                                                    {:else}
                                                        <span class="no-actions"
                                                            >—</span
                                                        >
                                                    {/if}
                                                </div>
                                            </td>
                                        {/if}
                                    </tr>
                                {/each}
                            {/each}
                        {:else}
                            <tr>
                                <td colspan="8" class="empty"
                                    >За этот период заказов нет.</td
                                >
                            </tr>
                        {/if}
                    </tbody>
                </table>
            </div>
        </div>
    </section>
    {/if}

    {#if showCogs}
        <CogsPanel products={costCandidates} onClose={() => (showCogs = false)} />
    {/if}
</div>

<style>
    /* Font optimization: Moved to app.html for zero CLS */

    /* Redundant :root and :global(body) removed (now in app.css) */

    .dashboard {
        max-width: var(--max-content-width);
        margin: 0 auto;
        padding: var(--space-lg) var(--space-md);
    }

    .actions-list {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .action-tag {
        font-size: 0.75rem;
        background: transparent;
        color: var(--text-secondary);
        padding: 0.15rem 0.4rem;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        line-height: 1.2;
    }

    .no-actions {
        color: var(--text-muted);
        font-size: 0.8125rem;
    }

    .card {
        background: var(--bg-card);
        padding: var(--space-xl);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        display: flex;
        gap: var(--space-lg);
        align-items: center;
        transition: all 0.3s ease;
    }

    .glass {
        background: transparent;
    }

    .details-section .full-width {
        flex-direction: column;
        align-items: stretch;
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

    .name-cell {
        min-width: 120px;
        max-width: clamp(150px, 20vw, 300px);
        font-size: var(--text-sm);
        line-height: 1.3;
        word-wrap: break-word;
        overflow-wrap: break-word;
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

    .price-cell {
        font-weight: 500;
        color: var(--text-primary);
        white-space: nowrap;
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

    .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-md);
        flex-wrap: wrap;
        margin-bottom: var(--space-lg);
    }

    .section-header h2 {
        font-family: var(--font-heading);
        margin: 0;
        font-size: 1.25rem;
        font-weight: 600;
        letter-spacing: 0.05em;
        opacity: 0.9;
    }

    .table-container {
        overflow-x: auto;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-subtle);
        background: var(--bg-card);
        -webkit-overflow-scrolling: touch;
    }

    table {
        width: 100%;
        min-width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        text-align: left;
        table-layout: auto;
    }

    thead {
        position: sticky;
        top: 0;
        z-index: 10;
    }

    th {
        padding: var(--space-sm) var(--space-md);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        background: var(--bg-elevated);
        border-bottom: 1px solid var(--border-subtle);
        white-space: nowrap;
    }

    th:first-child {
        border-top-left-radius: var(--radius-md);
    }

    th:last-child {
        border-top-right-radius: var(--radius-md);
    }

    td {
        padding: var(--space-sm) var(--space-md);
        border-bottom: 1px solid var(--border-subtle);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
        vertical-align: middle;
        transition: background-color var(--transition-fast);
    }

    tbody tr:nth-child(even) {
        background-color: rgba(255, 255, 255, 0.015);
    }

    tbody tr {
        transition: background-color var(--transition-fast);
    }

    tbody tr:hover {
        background-color: rgba(255, 255, 255, 0.04);
    }

    tbody tr:hover td:first-child {
        box-shadow: inset 3px 0 0 var(--accent-gold);
    }

    tbody tr:last-child td {
        border-bottom: none;
    }

    tbody tr:last-child td:first-child {
        border-bottom-left-radius: var(--radius-md);
    }

    tbody tr:last-child td:last-child {
        border-bottom-right-radius: var(--radius-md);
    }

    .empty {
        text-align: center;
        padding: 48px 24px;
        color: var(--text-muted);
        font-size: 0.875rem;
        background: transparent;
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

    .section-title {
        font-family: var(--font-heading);
        font-size: 1.25rem;
        margin-bottom: var(--space-lg);
        color: var(--text-primary);
        font-weight: 600;
        letter-spacing: 0.05em;
        opacity: 0.9;
    }

    /* Bento Grid System */
    .bento-header {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-bottom: var(--space-lg);
    }

    .section-title {
        font-family: var(--font-heading);
        font-size: 1.25rem;
        color: var(--text-primary);
        font-weight: 600;
        letter-spacing: 0.05em;
        margin: 0;
    }

    .bento-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        grid-template-rows: repeat(2, minmax(160px, auto)) minmax(120px, auto);
        gap: 16px;
        grid-template-areas:
            "hero hero week"
            "hero hero month"
            "small1 small2 small3";
    }

    @media (max-width: 1024px) {
        .bento-grid {
            grid-template-columns: 1fr 1fr;
            grid-template-areas:
                "hero hero"
                "week month"
                "small1 small2"
                "small3 small3";
        }
    }

    @media (max-width: 768px) {
        .bento-grid {
            display: flex;
            flex-direction: column;
        }
        .hero-card {
            min-height: 200px;
        }
    }

    .bento-card {
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: var(--space-lg);
        overflow: hidden;
        transition:
            transform 0.3s ease,
            box-shadow 0.3s ease;
    }

    .bento-card:hover {
        transform: translateY(-2px);
    }

    .glass-panel {
        background: rgba(20, 20, 20, 0.4);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.08); /* 0.5px visual feel */
        border-radius: 20px;
        box-shadow: 0 4px 24px -1px rgba(0, 0, 0, 0.2);
    }

    /* Areas */
    .hero-card {
        grid-area: hero;
    }
    .bento-grid > div:nth-child(2) {
        grid-area: week;
    }
    .bento-grid > div:nth-child(3) {
        grid-area: month;
    }
    .bento-grid > div:nth-child(4) {
        grid-area: small1;
    }
    .bento-grid > div:nth-child(5) {
        grid-area: small2;
    }
    .bento-grid > div:nth-child(6) {
        grid-area: small3;
    }

    /* Hero Styling */
    .glow-effect {
        background: radial-gradient(
                circle at top right,
                rgba(212, 175, 55, 0.05),
                transparent 60%
            ),
            rgba(20, 20, 20, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow:
            0 0 40px -10px rgba(0, 0, 0, 0.5),
            inset 0 0 0 1px rgba(255, 255, 255, 0.05);
    }

    .card-content {
        height: 100%;
        display: flex;
        flex-direction: column;
        position: relative;
        z-index: 2;
    }

    .hero-card .card-content {
        justify-content: space-between;
    }

    .card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
    }

    .bento-label {
        font-family: var(--font-heading);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.15em;
        color: var(--accent-gold);
        opacity: 0.9;
        font-weight: 600;
    }

    .bento-label.small {
        font-size: 0.65rem;
        color: var(--text-muted);
        margin-bottom: auto;
    }

    .live-indicator {
        display: inline-block;
        width: 6px;
        height: 6px;
        background: #10b981;
        border-radius: 50%;
        box-shadow: 0 0 8px #10b981;
    }

    /* Typography & Diamond Effect */
    .diamond-text {
        font-family: var(--font-heading);
        font-weight: 700;
        color: #fff;
        letter-spacing: -0.02em;

        /* Cold Diamond Gradient */
        background: linear-gradient(180deg, #ffffff 20%, #eff6ff 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        text-shadow: 0 2px 10px rgba(255, 255, 255, 0.15);
    }

    .text-xl {
        font-size: clamp(2.5rem, 4vw, 4.5rem);
        line-height: 1;
    }
    .text-lg {
        font-size: clamp(1.5rem, 2vw, 2.5rem);
        line-height: 1.1;
    }
    .text-md {
        font-size: 1.5rem;
        line-height: 1.2;
    }

    .currency-symbol {
        font-size: 1.5rem;
        color: var(--text-muted);
        vertical-align: top;
        margin-right: 4px;
        font-weight: 400;
        opacity: 0.5;
    }

    .unit {
        font-size: 0.875rem;
        color: var(--text-muted);
        opacity: 0.5;
        margin-left: 4px;
    }

    .card-main-value {
        margin: var(--space-md) 0;
    }

    .card-sub-stats {
        display: flex;
        align-items: center;
        gap: var(--space-md);
        padding-top: var(--space-md);
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        flex-wrap: wrap;
    }

    .sub-stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .sub-label {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--text-muted);
    }

    .sub-value {
        font-family: var(--font-body);
        font-size: 0.9rem;
        color: var(--text-secondary);
        font-weight: 500;
    }

    .separator {
        width: 1px;
        height: 24px;
        background: rgba(255, 255, 255, 0.1);
    }

    .text-error {
        color: var(--error);
    }

    /* Medium & Small specific */
    .medium-card .card-content {
        justify-content: space-between;
    }

    .card-value-group {
        margin: auto 0;
    }

    .small-card {
        align-items: flex-start;
        padding: var(--space-md);
    }

    .small-value {
        margin-top: 8px;
        margin-bottom: 4px;
    }

    .micro-stat {
        font-size: 0.7rem;
        color: var(--text-muted);
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
        width: 48px;
        height: 48px;
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

    .id-label {
        font-size: 0.75rem;
        color: var(--text-muted);
        margin-top: 2px;
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

    .breakdown-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
        gap: 16px;
    }

    .muted-note {
        color: var(--text-muted);
        font-size: var(--text-sm);
        margin: 0;
    }

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
    .breakdown-grid > .panel:first-child {
        grid-column: 1 / -1;
    }

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

    /* --- Order statuses by window --- */

    .status-legend {
        display: flex;
        gap: var(--space-md);
        margin-bottom: var(--space-md);
    }

    .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .legend-dot {
        width: 9px;
        height: 9px;
        border-radius: 2px;
    }

    .status-chart {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .status-row {
        display: grid;
        grid-template-columns: minmax(110px, 170px) 1fr;
        align-items: center;
        gap: var(--space-md);
    }

    .status-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .status-bars {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
    }

    .status-bar-cell {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .bar-track {
        flex: 1;
        height: 8px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.05);
        overflow: hidden;
    }

    .bar-fill {
        height: 100%;
        border-radius: 4px;
        transition: width var(--transition-base);
    }

    .bar-count {
        min-width: 3ch;
        text-align: right;
        font-size: 0.72rem;
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
    }

    .total-row {
        border-top: 1px solid var(--border-subtle);
        padding-top: 10px;
    }

    .total-row .status-label {
        color: var(--text-primary);
        font-weight: 600;
    }

    .bar-count.total {
        font-weight: 700;
    }

    /* --- Hourly activity --- */

    .hour-panel {
        margin-bottom: var(--space-lg);
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

        .section-title,
        .section-header h2 {
            font-size: 1.05rem;
        }

        .bento-header {
            flex-wrap: wrap;
            gap: var(--space-sm);
        }

        .bento-card,
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

        /* Status rows: label above the bars. */
        .status-row {
            grid-template-columns: 1fr;
            gap: 6px;
        }

        .status-label {
            white-space: normal;
        }

        .status-bars {
            gap: 8px;
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

        /* Let wide data tables scroll horizontally with readable columns. */
        table {
            min-width: 720px;
        }

        .section-header {
            align-items: flex-start;
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

    .live-indicator.busy {
        animation: dot-pulse 1.4s ease-in-out infinite;
    }

    /* Stale data is not "live": say so in colour, not only in a tooltip. */
    .live-indicator.stale {
        background: var(--warning);
        box-shadow: 0 0 8px var(--warning);
    }

    @keyframes dot-pulse {
        0%,
        100% {
            opacity: 1;
            transform: scale(1);
        }
        50% {
            opacity: 0.35;
            transform: scale(1.35);
        }
    }

    /* Placeholder shapes. Sizes mirror the content they stand in for, so the
       layout does not jump when the numbers arrive. */
    .sk-hero {
        height: 3.5rem;
        width: 70%;
        margin-bottom: var(--space-md);
    }

    .sk-medium {
        height: 2rem;
        width: 60%;
        margin: var(--space-sm) 0;
    }

    .sk-small {
        height: 1.5rem;
        width: 55%;
        margin-top: 8px;
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

    /* Class letters carry the meaning, so they are visible rather than colour-only. */
    .abc-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        margin-right: 6px;
        border-radius: 4px;
        font-size: 0.65rem;
        font-weight: 700;
        background: rgba(255, 255, 255, 0.08);
        color: var(--text-primary);
    }

    .abc-badge[data-grade="A"] {
        background: rgba(16, 185, 129, 0.18);
        color: #34d399;
    }

    .abc-badge[data-grade="B"] {
        background: rgba(234, 179, 8, 0.16);
        color: var(--accent-gold);
    }

    .loss-panel {
        margin-top: var(--space-lg);
        border-color: rgba(239, 68, 68, 0.3);
    }

    .loss-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .loss-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--space-md);
    }

    .loss-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--text-sm);
        color: var(--text-primary);
    }

    .loss-money {
        text-align: right;
        white-space: nowrap;
    }

    .loss-value {
        display: block;
        color: var(--error);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }

    .loss-detail {
        display: block;
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    /* Freshness of the financial layer, shown next to its title. */
    .freshness {
        margin-left: auto;
        font-size: 0.7rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        white-space: nowrap;
    }

    /* --- Action feed --- */

    .action-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .action-card {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-md);
        padding: var(--space-md);
        border: 1px solid var(--border-subtle);
        border-left: 3px solid var(--border-hover);
        border-radius: var(--radius-sm);
        background: var(--bg-card);
    }

    .action-card[data-severity="high"] {
        border-left-color: var(--error);
    }

    .action-card[data-severity="medium"] {
        border-left-color: var(--warning);
    }

    .action-card[data-severity="low"] {
        border-left-color: var(--info);
    }

    .action-main {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .action-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    /* Severity is spelled out, not encoded in colour alone. */
    .action-severity {
        font-size: 0.62rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        color: var(--text-secondary);
        white-space: nowrap;
    }

    .action-severity[data-severity="high"] {
        background: rgba(239, 68, 68, 0.16);
        color: #f87171;
    }

    .action-severity[data-severity="medium"] {
        background: rgba(234, 179, 8, 0.15);
        color: var(--accent-gold);
    }

    .action-title {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
    }

    .action-detail {
        font-size: 0.75rem;
        color: var(--text-secondary);
        line-height: 1.45;
    }

    .action-skus {
        font-size: 0.7rem;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .action-amount {
        text-align: right;
        white-space: nowrap;
    }

    .action-value {
        display: block;
        font-family: var(--font-heading);
        font-weight: 700;
        font-size: 1rem;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
    }

    .action-basis {
        display: block;
        font-size: 0.65rem;
        color: var(--text-muted);
    }

    @media (max-width: 640px) {
        .action-card {
            flex-direction: column;
        }

        .action-amount {
            text-align: left;
        }
    }
</style>
