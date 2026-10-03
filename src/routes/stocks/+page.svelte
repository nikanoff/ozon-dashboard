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

    // Runs once the list reflects the loaded data.
    $effect(() => {
        const sku = highlightSku;
        if (!sku || !$stocksData?.items?.length) return;

        // Matched by attribute alone, not by tag: the row used to be a table row and is a
        // card now, and the selector silently found nothing while both existed.
        const element = document.querySelector(`[data-sku="${CSS.escape(sku)}"]`);
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
        error={error}
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
            <div class="stock-list">
                {#if $isLoading}
                    {#each Array(5) as _, index (index)}
                        <div class="stock-card" aria-hidden="true">
                            <span class="skeleton stock-thumb"></span>
                            <span class="skeleton stock-line"></span>
                        </div>
                    {/each}
                {:else if $stocksData && $stocksData.items}
                    {#each $stocksData.items as item, index (`${item.product_id}-${index}`)}
                        <article
                            class="stock-card"
                            class:highlighted={String(item.stocks?.[0]?.sku) ===
                                highlightSku}
                            data-sku={item.stocks?.[0]?.sku}
                        >
                            <div class="product-image-container">
                                {#if $stocksData?.imagesMap?.[String(item.product_id)]}
                                    <img
                                        src={$stocksData.imagesMap[String(item.product_id)]}
                                        alt={item.offer_id}
                                        class="product-thumb"
                                        width="48"
                                        height="48"
                                        loading="lazy"
                                        decoding="async"
                                    />
                                {:else}
                                    <div class="product-thumb-placeholder">
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
                                            /><circle cx="8.5" cy="8.5" r="1.5" /><polyline
                                                points="21 15 16 10 5 21"
                                            /></svg
                                        >
                                    </div>
                                {/if}
                            </div>

                            <div class="stock-body">
                                <code class="offer-id">{item.offer_id}</code>
                                <div class="stock-ids">
                                    <span class="sku-label"
                                        >SKU: {item.stocks?.[0]?.sku || "N/A"}</span
                                    >
                                    <span class="id-label">PID: {item.product_id}</span>
                                </div>

                                <dl class="stock-figures">
                                    <div class="figure">
                                        <dt>FBO</dt>
                                        <dd
                                            >{item.stocks.find((s) => s.type === "fbo")
                                                ?.present || 0}</dd
                                        >
                                    </div>
                                    <div class="figure">
                                        <dt>В резерве</dt>
                                        <dd
                                            >{item.stocks.reduce(
                                                (acc, s) => acc + (s.reserved || 0),
                                                0,
                                            )}</dd
                                        >
                                    </div>
                                    <div class="figure">
                                        <dt>Всего</dt>
                                        <dd
                                            >{item.stocks.reduce(
                                                (acc, s) => acc + s.present,
                                                0,
                                            )}</dd
                                        >
                                    </div>
                                </dl>
                            </div>
                        </article>
                    {/each}
                {:else if error}
                    <div class="stock-empty">
                        Данные не загружены — смотрите сообщение об ошибке выше.
                    </div>
                {:else}
                    <div class="stock-empty">Товаров нет.</div>
                {/if}
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

    /*
        Stock rows are cards, not table rows.
        Five columns could not fit a phone, and the mobile rule forced a 560px minimum width,
        so the whole page scrolled sideways. A card holds the same five fields and wraps.
    */
    .stock-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);
    }

    .stock-card {
        display: flex;
        align-items: flex-start;
        gap: var(--space-md);
        padding: var(--space-md);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: var(--bg-card);
        transition: background-color var(--transition-fast);
    }

    .stock-card:hover {
        background-color: rgba(255, 255, 255, 0.04);
    }

    /* `min-width: 0` is what lets a long article code wrap instead of widening the card. */
    .stock-body {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-xs);
    }

    .stock-ids {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-sm);
    }

    .stock-figures {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
        gap: var(--space-sm);
        margin: var(--space-xs) 0 0;
        padding-top: var(--space-sm);
        border-top: 1px solid var(--border-subtle);
    }

    .figure {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    .figure dt {
        font-size: var(--text-xs);
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .figure dd {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
    }

    .stock-empty {
        padding: 48px 24px;
        text-align: center;
        color: var(--text-muted);
        font-size: 0.875rem;
    }

    .skeleton.stock-thumb {
        width: 48px;
        height: 48px;
        flex: 0 0 auto;
        border-radius: var(--radius-sm);
    }

    .skeleton.stock-line {
        flex: 1 1 auto;
        height: 1.5rem;
    }


    /* The item the reader followed a link to: gold border and gold text, as before. */
    .stock-card.highlighted {
        background-color: rgba(212, 175, 55, 0.1);
        border-color: rgba(212, 175, 55, 0.5);
    }

    .stock-card.highlighted .offer-id,
    .stock-card.highlighted .sku-label {
        color: #d4af37;
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

    }
</style>
