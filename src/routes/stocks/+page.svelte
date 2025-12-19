<script lang="ts">
    import { getStocks, getProductImages } from "$lib/ozon_api";
    import { useSWR } from "$lib/swr";
    import { ozonKeys } from "$lib/stores/ozon_keys";
    import OzonAuth from "$lib/components/OzonAuth.svelte";
    import { onDestroy } from "svelte";
    import { page } from "$app/stores";
    import { onMount } from "svelte";

    let highlightSku: string | null = null;

    // Subscribe to page changes to update highlightSku when URL changes
    $: {
        highlightSku = $page.url.searchParams.get("highlight");
        console.log("Highlight SKU:", highlightSku);

        // Scroll to the highlighted element when it becomes available
        if (highlightSku) {
            // Wait for the DOM to update before scrolling
            setTimeout(() => {
                // Only run in browser environment where document is available
                if (
                    typeof document !== "undefined" &&
                    typeof window !== "undefined"
                ) {
                    // First try to find element by data attribute, then by class
                    let highlightedElement = document.querySelector(
                        `.product-info-td[data-sku="${highlightSku}"]`,
                    );
                    if (!highlightedElement) {
                        highlightedElement = document.querySelector(
                            ".product-info-td.highlighted",
                        );
                    }
                    if (highlightedElement) {
                        // Add the scroll-highlight class to trigger animation
                        highlightedElement.classList.add("scroll-highlight");
                        highlightedElement.scrollIntoView({
                            behavior: "smooth",
                            block: "center",
                        });
                        // Remove the animation class after it completes
                        setTimeout(() => {
                            if (highlightedElement) {
                                highlightedElement.classList.remove(
                                    "scroll-highlight",
                                );
                            }
                        }, 1500); // Match the animation duration
                    }
                }
            }, 10); // Small delay to ensure DOM is updated
        }
    }

    const swrResult = useSWR(
        "ozon-stocks",
        async () => {
            const stocks = await getStocks();
            const items = stocks?.result?.items || stocks?.items || [];

            // Fetch images based on unique product IDs
            const productIds = Array.from(
                new Set(items.map((i: any) => String(i.product_id))),
            ) as string[];
            const imagesMap: Record<string, string> = {};

            if (productIds.length > 0) {
                try {
                    // Ozon API limit for pictures info is usually 100/1000 items, we handle it simply here
                    const picsResponse = await getProductImages(productIds);
                    const pics =
                        picsResponse?.result?.items ||
                        picsResponse?.items ||
                        [];
                    pics.forEach((p: any) => {
                        imagesMap[String(p.product_id)] =
                            p.primary_photo?.[0] || p.photo?.[0] || "";
                    });
                } catch (e) {
                    console.error("Failed to fetch images:", e);
                }
            }

            return {
                items,
                imagesMap,
            };
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
    onDestroy(() => {
        console.log("[Stocks] Component destroyed, cleaning up SWR resources");
        if (dispose) {
            dispose();
        }
    });

    // Refresh data when keys change
    $: if ($ozonKeys.clientId || $ozonKeys.apiKey) {
        mutate();
    }

    $: error = $swrError?.message || null;
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
    <header class="header">
        <div class="header-content">
            <h1>Product Stocks</h1>
            <p class="subtitle">
                Inventory management for Seller ID: {$ozonKeys.clientId ||
                    "Not Configured"}
            </p>
            <nav class="nav-menu">
                <a href="/" class="nav-link">← Dashboard</a>
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
                                <tr>
                                    <td>
                                        <div class="product-image-container">
                                            {#if $stocksData?.imagesMap?.[String(item.product_id)]}
                                                <img
                                                    src={$stocksData.imagesMap[
                                                        String(item.product_id)
                                                    ]}
                                                    alt={item.offer_id}
                                                    class="product-thumb"
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
                                    <td
                                        class="product-info-td {item.stocks?.[0]
                                            ?.sku == highlightSku
                                            ? 'highlighted'
                                            : ''}"
                                        data-sku={item.stocks?.[0]?.sku}
                                    >
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
                                            (s: any) => s.type === "fbo",
                                        )?.present || 0}</td
                                    >
                                    <td
                                        >{item.stocks.reduce(
                                            (acc: number, s: any) =>
                                                acc + (s.reserved || 0),
                                            0,
                                        )}</td
                                    >
                                    <td
                                        >{item.stocks.reduce(
                                            (acc: number, s: any) =>
                                                acc + s.present,
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
        0%,
        100% {
            opacity: 1;
            transform: scale(1);
        }
        50% {
            opacity: 0.4;
            transform: scale(1.2);
        }
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

    .product-info-td.highlighted {
        background-color: rgba(
            212,
            175,
            55,
            0.2
        ) !important; /* Gold highlight to match the theme */
        border-left: 3px solid #d4af37 !important;
        transition: all 0.3s ease;
    }

    .product-info-td.highlighted .product-info,
    .product-info-td.highlighted .sku-label,
    .product-info-td.highlighted .offer-id {
        color: #d4af37 !important; /* Gold text color */
        font-weight: 600;
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

    /* Christmas Decoration Styling */
    .christmas-decoration {
        position: absolute;
        top: 100%;
        margin-top: -1px;
        left: 75%;
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
</style>
