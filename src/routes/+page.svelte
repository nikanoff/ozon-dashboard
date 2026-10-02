<script lang="ts">
    import { getDashboardData, getStocksData } from "$lib/ozon_api";
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
    import { ozonKeys } from "$lib/stores/ozon_keys";
    import OzonHeader from "$lib/components/OzonHeader.svelte";
    import InfoTip from "$lib/components/InfoTip.svelte";
    import RangeToggle from "$lib/components/RangeToggle.svelte";
    import { get } from "svelte/store";
    import { onDestroy } from "svelte";

    const clientId = get(ozonKeys).clientId;
    const cacheKey = `ozon-dashboard:${clientId}`;

    const swrResult = useSWR(
        // Account-scoped key: cached data must not outlive a credentials change.
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

    const { data: stocksData, dispose: disposeStocks } = stocksResult;

    // Reload when the credentials change; useSWR already loads the initial value.
    refreshOnKeysChange(() => {
        mutate({ force: true });
        stocksResult.mutate({ force: true });
    });

    // Clean up resources when component is destroyed
    onDestroy(dispose);
    onDestroy(disposeStocks);

    const currencyFormatter = new Intl.NumberFormat("ru-RU", {
        style: "currency",
        currency: "RUB",
        maximumFractionDigits: 0,
    });

    function formatCurrency(value: number) {
        return currencyFormatter.format(value);
    }

    const numberFormatter = new Intl.NumberFormat("ru-RU");
    function formatNumber(value: number) {
        return numberFormatter.format(value);
    }

    function formatPercent(value: number) {
        return `${value.toFixed(1)}%`;
    }

    /** Signed change, or a dash when there is nothing to compare against. */
    function formatDelta(value: number | null) {
        if (value === null) return "—";
        return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
    }

    const isUp = (value: number | null) => value !== null && value >= 0;
    const isDown = (value: number | null) => value !== null && value < 0;

    const pad = (value: number) => String(value).padStart(2, "0");

    /** Short label for a posting status, falling back to the raw value. */
    const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

    /** Colors for the three window series (7 / 14 / 31 days). */
    const SERIES_COLORS = ["#6366f1", "#a855f7", "#eab308"];
    const seriesColor = (index: number) => SERIES_COLORS[index] ?? "#71717a";

    const postingsData = $derived($dashboardData?.postings ?? []);
    const error = $derived($swrError?.message ?? null);

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
    // Without stock rows every selling SKU would look out of stock, so the join is
    // only run once the inventory payload has arrived.
    const inventory = $derived(
        stockRows.length > 0
            ? inventoryInsights(postingsData, stockRows)
            : inventoryInsights([], []),
    );

    // Dynamic title for the browser tab, showing today's net sales once there are any.
    const pageTitle = $derived(
        stats.calendarDay.netSum > 0
            ? `${formatCurrency(stats.calendarDay.netSum).replace("₽", "").trim()} ₽ сегодня | Ozon Dashboard`
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
        onRefresh={() => mutate({ force: true })}
    />

    {#if error}
        <div class="error-card">
            <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                stroke="currentColor"
                fill="none"
                stroke-width="2"
                ><circle cx="12" cy="12" r="10" /><line
                    x1="12"
                    y1="8"
                    x2="12"
                    y2="12"
                /><line x1="12" y1="16" x2="12.01" y2="16" /></svg
            >
            <p>{error}</p>
        </div>
    {/if}

    <section class="stats-section">
        <div class="bento-header">
            <h2 class="section-title">Performance Analytics</h2>
        </div>

        <div class="bento-grid">
            <!-- Hero Card: Calendar Day -->
            <div class="bento-card hero-card glass-panel glow-effect">
                <div class="card-content">
                    <div class="card-header">
                        <span class="bento-label">Calendar Day</span>
                        <span class="live-indicator"></span>
                    </div>
                    <div class="card-main-value">
                        <span class="currency-symbol">₽</span>
                        <!-- Main: Net Sales (Total with cancellations) -->
                        <span class="diamond-text text-xl"
                            >{formatCurrency(stats.calendarDay.netSum)
                                .replace("₽", "")
                                .trim()}</span
                        >
                        <div class="main-label">Net Sales</div>
                    </div>
                    <div class="card-sub-stats">
                        <div class="sub-stat">
                            <span class="sub-label">Gross Sales</span>
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
                            >{formatCurrency(stats.calendarWeek.netSum)
                                .replace("₽", "")
                                .trim()}</span
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
                            <span class="mini-label">Gross:</span>
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
                            >{formatCurrency(stats.calendarMonth.netSum)
                                .replace("₽", "")
                                .trim()}</span
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
                            <span class="mini-label">Gross:</span>
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
                        >{formatCurrency(stats.last24h.netSum)
                            .replace("₽", "")
                            .trim()}</span
                    >
                </div>
                <div class="micro-stat-group">
                    <div class="micro-stat">
                        Orders: {stats.last24h.count}
                    </div>
                    <div class="micro-stat">
                        Gross: {formatCurrency(stats.last24h.sum)}
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
                        >{formatCurrency(stats.last7d.netSum)
                            .replace("₽", "")
                            .trim()}</span
                    >
                </div>
                <div class="micro-stat-group">
                    <div class="micro-stat">
                        Orders: {stats.last7d.count}
                    </div>
                    <div class="micro-stat">
                        Gross: {formatCurrency(stats.last7d.sum)}
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
                        >{formatCurrency(stats.last31d.netSum)
                            .replace("₽", "")
                            .trim()}</span
                    >
                </div>
                <div class="micro-stat-group">
                    <div class="micro-stat">
                        Orders: {stats.last31d.count}
                    </div>
                    <div class="micro-stat">
                        Gross: {formatCurrency(stats.last31d.sum)}
                    </div>
                    {#if stats.last31d.cancelled > 0}
                        <div class="micro-stat text-error">
                            -{formatCurrency(stats.last31d.cancelledSum)} ({stats
                                .last31d.cancelled})
                        </div>
                    {/if}
                </div>
            </div>
        </div>
    </section>

    <section class="insights-section">
        <div class="bento-header">
            <h2 class="section-title">Ключевые показатели · текущий месяц</h2>
            <InfoTip
                text="Производные показатели за текущий календарный месяц: средний чек, доля отмен, штук в заказе, средняя цена, проданные штуки и число кросс-кластерных отправлений. Динамика 24ч/7д сравнивается с предыдущими сутками и неделей."
                label="Пояснение к ключевым показателям"
            />
        </div>
        <div class="kpi-strip">
            {#each derivedMetrics as metric (metric.label)}
                <div class="kpi-chip glass-panel">
                    <span class="kpi-label">{metric.label}</span>
                    <span class="kpi-value">{metric.value}</span>
                </div>
            {/each}
            <div class="kpi-chip glass-panel">
                <span class="kpi-label">Выручка за 24ч</span>
                <span class="kpi-value"
                    >{formatCurrency(deltas.last24h.revenue)}</span
                >
                <span
                    class="kpi-delta"
                    class:positive={isUp(deltas.last24h.revenueChangePct)}
                    class:negative={isDown(deltas.last24h.revenueChangePct)}
                    >{formatDelta(deltas.last24h.revenueChangePct)} к пред.
                    суткам</span
                >
            </div>
            <div class="kpi-chip glass-panel">
                <span class="kpi-label">Выручка за 7 дней</span>
                <span class="kpi-value"
                    >{formatCurrency(deltas.last7d.revenue)}</span
                >
                <span
                    class="kpi-delta"
                    class:positive={isUp(deltas.last7d.revenueChangePct)}
                    class:negative={isDown(deltas.last7d.revenueChangePct)}
                    >{formatDelta(deltas.last7d.revenueChangePct)} к пред.
                    неделе</span
                >
            </div>
        </div>

        <div class="panel glass-panel trend-panel">
            <div class="panel-head">
                <span class="panel-title-group">
                    <h3 class="panel-title">Тренд чистой выручки · {windowDays} дн.</h3>
                    <InfoTip
                        text="Чистая выручка по дням за выбранное окно (без отменённых заказов). Окно 7/14/31 дня задаётся переключателем справа и общее для тренда и графика по часам."
                        label="Пояснение к тренду выручки"
                    />
                </span>
                <div class="panel-controls">
                    <span class="panel-note">максимум {formatCurrency(trendMax)} в день</span>
                    <RangeToggle bind:value={windowDays} />
                </div>
            </div>
            <div class="trend-chart">
                {#each trend as point (point.date)}
                    <div
                        class="trend-bar-wrap"
                        title="{point.date}: {formatCurrency(point.netRevenue)} · {point.orders} заказов"
                    >
                        <div
                            class="trend-bar"
                            style="height: {Math.max(2, Math.round((point.netRevenue / trendMax) * 100))}%"
                        ></div>
                    </div>
                {/each}
            </div>
            <div class="trend-axis">
                <span>{trend[0]?.date ?? ""}</span>
                <span>{trend.at(-1)?.date ?? ""}</span>
            </div>
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
                            class:peak={point.hour === peakHour.hour && point.orders > 0}
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
                {#if top.length === 0}
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
                {#if cities.length === 0}
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
                {#if payments.length === 0}
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
                {#if routes.length === 0}
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
                {#if actionStats.length === 0}
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

        {#if stockRows.length === 0}
            <div class="panel glass-panel muted-note">
                Остатки не загружены: оборачиваемость появится, когда придут данные
                со страницы остатков.
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
                            <th>Total Price</th>
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
                                {#each posting.products as product, i (product.sku || product.name)}
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
                                        <td class="price-cell"
                                            >{formatCurrency(
                                                productUnitPrice(product) *
                                                    product.quantity,
                                            )}</td
                                        >
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
                                    >No orders found.</td
                                >
                            </tr>
                        {/if}
                    </tbody>
                </table>
            </div>
        </div>
    </section>
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
</style>
