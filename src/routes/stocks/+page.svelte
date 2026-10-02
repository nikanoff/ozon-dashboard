<script lang="ts">
    import { getStocksData } from "$lib/ozon_api";
    import { useSWR } from "$lib/swr";
    import { refreshOnKeysChange } from "$lib/refresh_on_keys";
    import { ozonKeys } from "$lib/stores/ozon_keys";
    import OzonHeader from "$lib/components/OzonHeader.svelte";
    import { onDestroy } from "svelte";
    import { page } from "$app/state";
    import { get } from "svelte/store";

    const swrResult = useSWR(
        // Account-scoped key: cached data must not outlive a credentials change.
        `ozon-stocks:${get(ozonKeys).clientId}`,
        async (signal) => {
            if (!$ozonKeys.clientId || !$ozonKeys.apiKey) {
                throw new Error(
                    "Укажите Client ID и API Key в настройках (шестерёнка справа сверху).",
                );
            }

            // The endpoint collects stock rows and their images in one request.
            return getStocksData(signal);
        },
        { dedupingInterval: 2000 },
    );

    const {
        data: stocksData,
        error: swrError,
        isLoading,
        isValidating,
        mutate,
        dispose,
    } = swrResult;

    // Clean up resources when component is destroyed
    onDestroy(dispose);

    // Reload when the credentials change; useSWR already loads the initial value.
    refreshOnKeysChange(() => mutate({ force: true }));

    const error = $derived($swrError?.message ?? null);

    // SKU to scroll to, taken from the URL (`/stocks?highlight=<sku>`).
    const highlightSku = $derived(page.url.searchParams.get("highlight"));

    // Runs once the table reflects the loaded data.
    $effect(() => {
        const sku = highlightSku;
        if (!sku || !$stocksData?.items?.length) return;

        const element = document.querySelector(`tr[data-sku="${sku}"]`);
        if (!element) return;

        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.classList.add("scroll-highlight");
        const timer = setTimeout(
            () => element.classList.remove("scroll-highlight"),
            2000,
        );

        return () => clearTimeout(timer);
    });
</script>

<svelte:head>
    <title>Остатки товаров | Ozon Seller Dashboard</title>
    <meta
        name="description"
        content="Управление остатками FBO на Ozon. Просмотр наличия товаров на складах в реальном времени."
    />
    <meta property="og:title" content="Остатки товаров | Ozon Dashboard" />
    <meta
        property="og:description"
        content="Управление остатками FBO на Ozon"
    />
</svelte:head>

<div class="dashboard">
    <OzonHeader
        title="Product Stocks"
        titleHref="/stocks"
        subtitle="Inventory management for Seller ID"
        navHref="/"
        navLabel="← Dashboard"
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

    <section class="details-section">
        <div class="card glass full-width">
            <div class="section-header">
                <h2>Product Stocks Inventory</h2>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th style="width: 80px;">Image</th>
                            <th>Product / SKU / Offer</th>
                            <th>FBO Stock</th>
                            <th>Reserved</th>
                            <th>Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#if $isLoading}
                            {#each Array(5) as _}
                                <tr>
                                    <td
                                        ><span
                                            class="skeleton"
                                            style="width: 50px; height: 50px;"
                                        ></span></td
                                    >
                                    <td><span class="skeleton"></span></td>
                                    <td><span class="skeleton"></span></td>
                                    <td><span class="skeleton"></span></td>
                                    <td><span class="skeleton"></span></td>
                                </tr>
                            {/each}
                        {:else if $stocksData && $stocksData.items}
                            {#each $stocksData.items as item (item.product_id)}
                                <tr
                                    class:highlighted={String(
                                        item.stocks?.[0]?.sku,
                                    ) === highlightSku}
                                    data-sku={item.stocks?.[0]?.sku}
                                >
                                    <td>
                                        <div class="product-image-container">
                                            {#if $stocksData?.imagesMap?.[String(item.product_id)]}
                                                <img
                                                    src={$stocksData.imagesMap[
                                                        String(item.product_id)
                                                    ]}
                                                    alt={item.offer_id}
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
                                                        width="16"
                                                        height="16"
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
                                    <td class="product-info-td">
                                        <div class="product-info">
                                            <code class="offer-id"
                                                >{item.offer_id}</code
                                            >
                                            <span class="sku-label"
                                                >SKU: {item.stocks?.[0]?.sku ||
                                                    "N/A"}</span
                                            >
                                            <span class="id-label"
                                                >PID: {item.product_id}</span
                                            >
                                        </div>
                                    </td>
                                    <td
                                        >{item.stocks.find(
                                            (s) => s.type === "fbo",
                                        )?.present || 0}</td
                                    >
                                    <td
                                        >{item.stocks.reduce(
                                            (acc, s) =>
                                                acc + (s.reserved || 0),
                                            0,
                                        )}</td
                                    >
                                    <td
                                        >{item.stocks.reduce(
                                            (acc, s) => acc + s.present,
                                            0,
                                        )}</td
                                    >
                                </tr>
                            {/each}
                        {:else}
                            <tr>
                                <td colspan="6" class="empty"
                                    >No products found or API error.</td
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
    /* Font styles are globalized in app.html */

    /* Redundant :root and :global(body) removed (now in app.css) */

    .dashboard {
        max-width: var(--max-content-width);
        margin: 0 auto;
        padding: var(--space-lg) var(--space-md);
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

    .card:hover {
        border-color: var(--border-hover);
        background: var(--bg-elevated);
    }

    .glass {
        background: transparent;
    }

    .details-section .full-width {
        flex-direction: column;
        align-items: stretch;
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

    .product-info {
        display: flex;
        flex-direction: column;
        gap: var(--space-xs);
        min-width: 100px;
        max-width: clamp(150px, 25vw, 350px);
        word-wrap: break-word;
        overflow-wrap: break-word;
    }

    tr.highlighted {
        background-color: rgba(212, 175, 55, 0.1) !important;
        position: relative;
        z-index: 1;
    }

    tr.highlighted td:first-child {
        box-shadow: inset 3px 0 0 var(--accent-gold);
    }

    tr.highlighted .product-info,
    tr.highlighted .sku-label,
    tr.highlighted .offer-id {
        color: #d4af37 !important; /* Gold text color */
        font-weight: 600;
    }

    /* Using :global to prevent Svelte from purging this dynamically added class */
    :global(.scroll-highlight) {
        animation: highlight-pulse 2s ease-in-out;
    }

    @keyframes highlight-pulse {
        0% {
            box-shadow: 0 0 0 0 rgba(212, 175, 55, 0);
        }
        20% {
            box-shadow: 0 0 0 0 rgba(212, 175, 55, 0.6);
        }
        50% {
            box-shadow: 0 0 0 10px rgba(212, 175, 55, 0);
            background-color: rgba(212, 175, 55, 0.1);
        }
        100% {
            box-shadow: 0 0 0 0 rgba(212, 175, 55, 0);
        }
    }

    .sku-label {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        line-height: 1.3;
    }

    .id-label {
        font-size: var(--text-xs);
        color: var(--text-muted);
    }

    .offer-id {
        background: rgba(255, 255, 255, 0.03);
        padding: var(--space-xs) var(--space-sm);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: 600;
        border: 1px solid var(--border-subtle);
        width: fit-content;
        font-family: monospace;
    }

    .empty {
        text-align: center;
        padding: 48px 24px;
        color: var(--text-muted);
        font-size: 0.875rem;
        background: transparent;
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

    @keyframes shimmer {
        0% {
            transform: translateX(-100%);
        }
        100% {
            transform: translateX(100%);
        }
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

    @keyframes shimmer {
        0% {
            transform: translateX(-100%);
        }
        100% {
            transform: translateX(100%);
        }
    }

    .product-image-container {
        width: 48px;
        height: 48px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        overflow: hidden;
        background: var(--bg-elevated);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .product-thumb {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .product-thumb-placeholder {
        color: var(--text-disabled);
        opacity: 0.5;
    }

    /* --- Mobile / small-screen layout --- */
    @media (max-width: 640px) {
        .dashboard {
            max-width: 100%;
            padding: var(--space-md) var(--space-sm);
        }

        .card {
            padding: var(--space-lg) var(--space-md);
        }

        .section-header h2 {
            font-size: 1.05rem;
        }

        /* Keep columns readable and let the table scroll sideways. */
        table {
            min-width: 560px;
        }

        .product-info {
            max-width: none;
        }
    }
</style>
