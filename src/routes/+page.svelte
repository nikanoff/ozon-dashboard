<script lang="ts">
    import { getFboPostings, getProductInfoList } from "$lib/ozon_api";
    import { useSWR } from "$lib/swr";
    import { ozonKeys } from "$lib/stores/ozon_keys";
    import OzonAuth from "$lib/components/OzonAuth.svelte";
    import { onMount, onDestroy } from "svelte";

    const swrResult = useSWR(
        "ozon-dashboard",
        async () => {
            const thirtyOneDaysAgo = new Date(
                Date.now() - 31 * 24 * 60 * 60 * 1000,
            ).toISOString();

            const postingsResponse = await getFboPostings(
                thirtyOneDaysAgo,
                new Date().toISOString(),
            ).catch(() => null);

            const postings = postingsResponse?.result || [];

            // Collect all unique SKUs from all products in all postings
            const allSkus = Array.from(
                new Set(
                    postings.flatMap(
                        (p: any) =>
                            p.products?.map((prod: any) => prod.sku) || [],
                    ),
                ),
            ) as number[];

            const skuToImage: Record<number, string> = {};

            if (allSkus.length > 0) {
                try {
                    // Fetch product info in batches of 1000 (Ozon limit for info/list)
                    // For now, we assume < 1000 unique SKUs in 31 days
                    const skusToFetch = allSkus.slice(0, 1000);
                    const infoResponse = await getProductInfoList(skusToFetch);
                    const items =
                        infoResponse?.result?.items ||
                        infoResponse?.items ||
                        infoResponse?.result ||
                        [];

                    items.forEach((item: any) => {
                        if (item.sku) {
                            skuToImage[item.sku] =
                                item.primary_image || item.images?.[0] || "";
                        }
                    });
                } catch (e) {
                    console.error(
                        "Failed to fetch product info for dashboard images:",
                        e,
                    );
                }
            }

            return {
                postings,
                skuToImage,
            };
        },
        { dedupingInterval: 2000 },
    );

    const {
        data: dashboardData,
        error: swrError,
        isLoading,
        isValidating,
        mutate,
        dispose,
    } = swrResult;

    // Clean up resources when component is destroyed
    onDestroy(() => {
        console.log(
            "[Dashboard] Component destroyed, cleaning up SWR resources",
        );
        if (dispose) {
            dispose();
        }
    });

    // Refresh data when keys change
    $: if ($ozonKeys.clientId || $ozonKeys.apiKey) {
        mutate();
    }

    $: postingsData = $dashboardData?.postings || [];
    $: error = $swrError?.message || null;

    // Pagination for orders
    let currentPage = 1;
    const itemsPerPage = 10;
    $: totalPages = Math.ceil(postingsData.length / itemsPerPage);
    $: sortedPostings = [...postingsData].sort(
        (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    $: paginatedPostings = sortedPostings.slice(
        (currentPage - 1) * itemsPerPage,
        currentPage * itemsPerPage,
    );

    // Stats variables
    let stats = {
        last24h: {
            count: 0,
            sum: 0,
            cancelled: 0,
            cancelledSum: 0,
            netSum: 0,
            crossCluster: 0,
        },
        last7d: {
            count: 0,
            sum: 0,
            cancelled: 0,
            cancelledSum: 0,
            netSum: 0,
            crossCluster: 0,
        },
        last31d: {
            count: 0,
            sum: 0,
            cancelled: 0,
            cancelledSum: 0,
            netSum: 0,
            crossCluster: 0,
        },
        calendarDay: {
            count: 0,
            sum: 0,
            cancelled: 0,
            cancelledSum: 0,
            netSum: 0,
            crossCluster: 0,
        },
        calendarWeek: {
            count: 0,
            sum: 0,
            cancelled: 0,
            cancelledSum: 0,
            netSum: 0,
            crossCluster: 0,
        },
        calendarMonth: {
            count: 0,
            sum: 0,
            cancelled: 0,
            cancelledSum: 0,
            netSum: 0,
            crossCluster: 0,
        },
    };

    $: if (postingsData) {
        calculateStats();
    }

    function formatCurrency(value: number) {
        return new Intl.NumberFormat("ru-RU", {
            style: "currency",
            currency: "RUB",
            maximumFractionDigits: 0,
        }).format(value);
    }

    function calculateStats() {
        const createEmptyStat = () => ({
            count: 0,
            sum: 0,
            cancelled: 0,
            cancelledSum: 0,
            netSum: 0,
            crossCluster: 0,
        });

        // Use local variable for calculation to avoid premature reactivity updates
        const newStats = {
            last24h: createEmptyStat(),
            last7d: createEmptyStat(),
            last31d: createEmptyStat(),
            calendarDay: createEmptyStat(),
            calendarWeek: createEmptyStat(),
            calendarMonth: createEmptyStat(),
        };

        const now = new Date();
        const startOfDay = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
        );
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const day = now.getDay();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - day + (day === 0 ? -6 : 1));
        startOfWeek.setHours(0, 0, 0, 0);

        const limit24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const limit7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const limit31d = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);

        const periods = [
            { key: "last24h", limit: limit24h },
            { key: "last7d", limit: limit7d },
            { key: "last31d", limit: limit31d },
            { key: "calendarDay", limit: startOfDay },
            { key: "calendarWeek", limit: startOfWeek },
            { key: "calendarMonth", limit: startOfMonth },
        ];

        postingsData.forEach((p: any) => {
            // Use created_at for consistent sales statistics based on order time
            const pDate = new Date(p.created_at);
            const price = (p.products || []).reduce(
                (acc: number, prod: any) =>
                    acc + parseFloat(prod.price) * (prod.quantity || 1),
                0,
            );

            periods.forEach(({ key, limit }) => {
                // Unified logic: Check if order date is after the limit threshold
                const isMatch = pDate >= limit;

                if (isMatch) {
                    // Type assertion to access dynamic keys on defined structure
                    const k = key as keyof typeof newStats;
                    newStats[k].count++;
                    newStats[k].sum += price;

                    if (p.status === "cancelled") {
                        newStats[k].cancelled++;
                        newStats[k].cancelledSum += price;
                    }

                    if (
                        p.financial_data?.cluster_from &&
                        p.financial_data?.cluster_to &&
                        p.financial_data.cluster_from !==
                            p.financial_data.cluster_to
                    ) {
                        newStats[k].crossCluster++;
                    }

                    newStats[k].netSum =
                        newStats[k].sum - newStats[k].cancelledSum;
                }
            });
        });

        // Final assignment triggers reactivity once
        stats = newStats;
    }

    $: statsConfig = [
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
    ];
</script>

<svelte:head>
    <title>Ozon Seller Dashboard | Аналитика продаж</title>
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
    <header class="header">
        <div class="header-content">
            <h1><a href="/" class="title-link">Ozon Dashboard</a></h1>
            <p class="subtitle">
                Real-time business insights for Seller ID: {$ozonKeys.clientId ||
                    "Not Configured"}
            </p>
            <nav class="nav-menu">
                <a href="/stocks" class="nav-link">View Stocks →</a>
            </nav>
        </div>
        <div class="header-actions">
            <button
                class="btn-refresh glass"
                on:click={() => mutate()}
                disabled={$isValidating}
            >
                <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    stroke="currentColor"
                    fill="none"
                    stroke-width="2"
                    ><path
                        d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
                    /></svg
                >
                {$isValidating ? "Updating..." : "Refresh Data"}
            </button>
            <div class="status-badge" class:loading={$isValidating}>
                <span class="pulse"></span>
                {$isValidating ? "Validating..." : "Live"}
            </div>
            <OzonAuth />
        </div>

        <!-- Christmas Decoration -->
        <div class="christmas-decoration">
            <div class="ornament-thread"></div>
            <div class="ornament-shell">
                <svg
                    viewBox="0 0 50 60"
                    width="50"
                    height="60"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <!-- Sparkling Stars -->
                    <circle
                        class="sparkle s1"
                        cx="10"
                        cy="35"
                        r="1"
                        fill="white"
                    />
                    <circle
                        class="sparkle s2"
                        cx="40"
                        cy="45"
                        r="1.2"
                        fill="white"
                    />
                    <circle
                        class="sparkle s3"
                        cx="15"
                        cy="50"
                        r="0.8"
                        fill="white"
                    />
                    <circle
                        class="sparkle s4"
                        cx="35"
                        cy="25"
                        r="1"
                        fill="white"
                    />

                    <!-- Attachment Ring/Star Base -->
                    <circle
                        cx="25"
                        cy="5"
                        r="3"
                        stroke="#D4AF37"
                        stroke-width="1"
                        stroke-opacity="0.8"
                    />

                    <!-- Tree Shape (3 levels) -->
                    <path
                        d="M25 10L35 25H15L25 10Z"
                        stroke="#D4AF37"
                        stroke-width="1.2"
                        stroke-opacity="0.9"
                    />
                    <path
                        d="M25 20L40 38H10L25 20Z"
                        stroke="#D4AF37"
                        stroke-width="1.2"
                        stroke-opacity="0.7"
                    />
                    <path
                        d="M25 33L45 55H5L25 33Z"
                        stroke="#D4AF37"
                        stroke-width="1.2"
                        stroke-opacity="0.5"
                    />

                    <!-- Tree Trunk -->
                    <rect
                        x="22"
                        y="55"
                        width="6"
                        height="4"
                        stroke="#D4AF37"
                        stroke-width="1"
                        stroke-opacity="0.4"
                    />

                    <!-- Top Star Decoration -->
                    <path
                        d="M25 8L26.5 11.5L30 11.5L27 13.5L28.5 17L25 15L21.5 17L23 13.5L20 11.5L23.5 11.5L25 8Z"
                        fill="#D4AF37"
                        fill-opacity="0.8"
                        class="sparkle s1"
                    />
                </svg>
            </div>
        </div>
    </header>

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
        <h2 class="section-title">FBO Postings Statistics</h2>
        <div class="stats-grid">
            {#each statsConfig as config (config.label)}
                <div class="stat-card">
                    <div class="stat-header">
                        <div
                            class="stat-icon-pod"
                            style="background: {config.color}1a; color: {config.color}"
                        >
                            <svg
                                viewBox="0 0 24 24"
                                width="18"
                                height="18"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                            >
                                {@html config.icon}
                            </svg>
                        </div>
                        <span class="stat-label">{config.label}</span>
                    </div>

                    <div class="stat-values">
                        <div class="stat-main">
                            <span class="stat-count"
                                >{config.value.count} orders</span
                            >
                            {#if config.value.cancelled > 0}
                                <span class="stat-cancelled">
                                    {config.value.cancelled} cancelled ({formatCurrency(
                                        config.value.cancelledSum,
                                    )})
                                </span>
                            {/if}
                            <span class="stat-total-label"
                                >Total: {formatCurrency(config.value.sum)}</span
                            >
                            {#if config.value.crossCluster > 0}
                                <span class="stat-cross-cluster">
                                    {config.value.crossCluster} inter-cluster movements
                                </span>
                            {/if}
                        </div>
                        <div class="stat-net">
                            <span class="stat-sum"
                                >{formatCurrency(config.value.netSum)}</span
                            >
                            <span class="net-label">Net Sales</span>
                        </div>
                    </div>
                </div>
            {/each}
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
                        on:click={() => currentPage--}>Prev</button
                    >
                    <span class="page-info"
                        >Page {currentPage} of {totalPages || 1}</span
                    >
                    <button
                        class="btn-page"
                        disabled={currentPage >= totalPages}
                        on:click={() => currentPage++}>Next</button
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
                                                parseFloat(product.price) *
                                                    product.quantity,
                                            )}</td
                                        >
                                        {#if i === 0}
                                            {@const allActions = [
                                                ...new Set(
                                                    posting.financial_data?.products?.flatMap(
                                                        (p: any) =>
                                                            p.actions || [],
                                                    ) || [],
                                                ),
                                            ]}
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
                                                    {#if allActions.length > 0}
                                                        {#each allActions as action}
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

    .header {
        position: relative;
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--space-xxl);
        padding: var(--space-xl) 0;
        border-bottom: 1px solid var(--border-subtle);
    }

    h1 {
        font-family: var(--font-heading);
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--text-primary);
        margin: 0;
        letter-spacing: 0.15em;
        text-transform: uppercase;
    }

    .title-link {
        color: inherit;
        text-decoration: none;
        transition: all 0.3s ease;
        display: inline-block;
        position: relative;
    }

    .title-link::after {
        content: "";
        position: absolute;
        width: 0;
        height: 1px;
        bottom: -2px;
        left: 0;
        background-color: var(--accent-gold);
        transition: width 0.3s ease;
        opacity: 0.7;
    }

    .title-link:hover {
        color: var(--accent-gold);
        text-shadow: 0 0 15px rgba(212, 175, 55, 0.3);
    }

    .title-link:hover::after {
        width: 100%;
    }

    .subtitle {
        color: var(--text-muted);
        font-size: 0.7rem;
        margin-top: 8px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
    }

    .nav-menu {
        margin-top: 16px;
    }

    .nav-link {
        color: var(--accent-gold);
        text-decoration: none;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        transition: opacity 0.2s;
    }

    .nav-link:hover {
        opacity: 0.7;
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

    .status-badge {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        border: 1px solid var(--border-subtle);
        font-size: 0.7rem;
        font-weight: 500;
        color: var(--text-primary);
        text-transform: uppercase;
        letter-spacing: 0.1em;
    }

    .status-badge.loading {
        border-color: #333;
        color: #888;
    }

    .pulse {
        width: 8px;
        height: 8px;
        background: currentColor;
        border-radius: 50%;
        animation: pulse 2s infinite;
    }

    @keyframes pulse {
        0% {
            opacity: 1;
            transform: scale(1);
        }
        50% {
            opacity: 0.4;
            transform: scale(1.2);
        }
        100% {
            opacity: 1;
            transform: scale(1);
        }
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

    .btn-refresh {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        padding: 0.5rem 1.25rem;
        border-radius: var(--radius-sm);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        transition: all 0.3s ease;
    }

    .btn-refresh:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.06);
        border-color: var(--border-hover);
        color: var(--text-primary);
    }

    .btn-refresh:disabled {
        opacity: 0.2;
        cursor: not-allowed;
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: var(--space-md);
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

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: var(--space-md);
    }

    .stat-card {
        background: var(--bg-card);
        padding: var(--space-lg);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
        transition: all 0.3s ease;
    }

    .stat-card:hover {
        border-color: var(--border-hover);
        background: var(--bg-elevated);
    }

    .stat-header {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .stat-icon-pod {
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.4;
    }

    .stat-label {
        font-size: 0.6rem;
        color: var(--text-muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.2em;
    }

    .stat-values {
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
    }

    .stat-main {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .stat-count {
        font-family: var(--font-heading);
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--text-primary);
        letter-spacing: 0.02em;
    }

    .stat-total-label {
        font-size: 0.65rem;
        color: var(--text-muted);
    }

    .stat-cancelled {
        font-size: 0.65rem;
        color: #ef4444; /* Red for emphasis on cancelled */
        font-weight: 500;
        opacity: 0.8;
    }

    .stat-cross-cluster {
        font-size: 0.6rem;
        color: #d4af37; /* Match ornament color for inter-cluster */
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-top: 4px;
    }

    .stat-net {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        border-top: 1px solid var(--border-subtle);
        padding-top: var(--space-md);
    }

    .stat-sum {
        font-family: var(--font-heading);
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--text-primary);
        letter-spacing: -0.01em;
    }

    .net-label {
        font-size: 0.55rem;
        text-transform: uppercase;
        letter-spacing: 0.2em;
        color: var(--text-muted);
        margin-top: 6px;
    }

    /* Christmas Decoration Styling */
    .christmas-decoration {
        position: absolute;
        top: 100%; /* Exactly at the bottom border of header */
        margin-top: -1px; /* Align perfectly with the 1px border */
        left: 75%; /* Positioned at 3/4 of the line */
        display: flex;
        flex-direction: column;
        align-items: center;
        transform-origin: top center;
        animation: sway 5s ease-in-out infinite;
        pointer-events: all;
        cursor: pointer;
        z-index: 100;
    }

    .ornament-thread {
        width: 1px;
        height: 80px;
        background: linear-gradient(to bottom, #d4af37, transparent);
        opacity: 0.5;
    }

    .ornament-shell {
        transition: all 0.3s ease;
        filter: drop-shadow(0 0 0px transparent);
    }

    .sparkle {
        animation: sparkle-anim 2s infinite ease-in-out;
        opacity: 0;
    }

    .s1 {
        animation-delay: 0.2s;
    }
    .s2 {
        animation-delay: 0.7s;
    }
    .s3 {
        animation-delay: 1.2s;
    }
    .s4 {
        animation-delay: 1.8s;
    }

    @keyframes sparkle-anim {
        0%,
        100% {
            opacity: 0;
            transform: scale(0);
        }
        50% {
            opacity: 0.8;
            transform: scale(1.2);
        }
    }

    .christmas-decoration:hover .ornament-shell {
        filter: drop-shadow(0 0 12px rgba(255, 255, 255, 0.4));
    }

    .christmas-decoration:hover .sparkle {
        animation-duration: 0.8s;
        opacity: 1;
    }

    .christmas-decoration:hover {
        animation-duration: 1.5s;
    }

    @keyframes sway {
        0% {
            transform: rotate(-6deg);
        }
        50% {
            transform: rotate(6deg);
        }
        100% {
            transform: rotate(-6deg);
        }
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
