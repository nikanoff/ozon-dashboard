<script lang="ts">
    import { getDashboardData } from "$lib/ozon_api";
    import {
        mergeDashboardPayload,
        needsFullLoad,
        refreshSince,
    } from "$lib/dashboard_cache";
    import type { DashboardPayload } from "$lib/ozon_types";
    import { peekCache, useSWR } from "$lib/swr";
    import { refreshOnKeysChange } from "$lib/refresh_on_keys";
    import { calculateStats, productUnitPrice } from "$lib/stats";
    import { ozonKeys } from "$lib/stores/ozon_keys";
    import OzonHeader from "$lib/components/OzonHeader.svelte";
    import { get } from "svelte/store";
    import { onDestroy } from "svelte";

    const cacheKey = `ozon-dashboard:${get(ozonKeys).clientId}`;

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

    // Reload when the credentials change; useSWR already loads the initial value.
    refreshOnKeysChange(() => mutate({ force: true }));

    // Clean up resources when component is destroyed
    onDestroy(dispose);

    const currencyFormatter = new Intl.NumberFormat("ru-RU", {
        style: "currency",
        currency: "RUB",
        maximumFractionDigits: 0,
    });

    function formatCurrency(value: number) {
        return currencyFormatter.format(value);
    }

    const postingsData = $derived($dashboardData?.postings ?? []);
    const error = $derived($swrError?.message ?? null);

    // Recomputed whenever the postings change.
    const stats = $derived(calculateStats(postingsData));

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
</style>
