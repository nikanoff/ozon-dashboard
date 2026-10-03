<script lang="ts">
    import { onMount, tick } from "svelte";
    import {
        clearCosts,
        costBook,
        exportCosts,
        importCosts,
        recordCost
    } from "$lib/stores/cogs";
    import { costAt } from "$lib/costs";
    import { formatCurrency } from "$lib/format";

    /**
     * Where the seller enters purchase prices.
     *
     * Ozon never reports a cost price, so this is the one number the dashboard cannot
     * fetch; without it "margin" would be a guess. Costs are committed on blur rather
     * than on every keystroke — writing each character would recompute the whole
     * economics layer mid-typing, which is how the credentials form ended up firing
     * requests at half-typed keys.
     */
    interface Props {
        /** Products seen in the loaded data, most valuable first. */
        products: { key: string; label: string; units: number; payout: number }[];
        onClose: () => void;
    }

    let { products, onClose }: Props = $props();

    let filter = $state("");
    let importText = $state("");
    let importNote = $state<string | null>(null);
    let panelEl: HTMLDivElement | undefined = $state();

    const today = new Date();

    const known = $derived(products.filter((item) => costAt($costBook, item.key, today)));
    const visible = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        if (!needle) return products;

        return products.filter(
            (item) =>
                item.key.toLowerCase().includes(needle) ||
                item.label.toLowerCase().includes(needle),
        );
    });

    /** Current cost of a product, or an empty string so the field looks untouched. */
    function currentCost(key: string): string {
        const resolved = costAt($costBook, key, today);
        return resolved === undefined ? "" : String(resolved.unitCost);
    }

    function commit(key: string, raw: string) {
        const value = Number(raw.replace(",", "."));
        if (!raw.trim() || !Number.isFinite(value) || value < 0) return;
        recordCost(key, value);
    }

    function handleImport() {
        const result = importCosts(importText);
        const skipped = result.skipped.length
            ? `, не разобрано строк: ${result.skipped.length}`
            : "";
        importNote = `Загружено позиций: ${result.imported}${skipped}`;
        if (result.imported > 0) importText = "";
    }

    function handleExport() {
        importText = exportCosts();
        importNote = "Список выгружен в поле ниже — скопируйте его в таблицу.";
    }

    /**
     * Closes on a click outside the panel, following the action pattern the
     * credentials panel already uses.
     *
     * The listener is armed on the next macrotask: the click that opened this panel is
     * still propagating while the panel mounts, and reacting to it would close the
     * dialog the user just opened.
     */
    function clickOutside(node: HTMLElement) {
        let armed = false;
        const arm = setTimeout(() => {
            armed = true;
        }, 0);

        const handle = (event: MouseEvent) => {
            if (armed && !node.contains(event.target as Node)) onClose();
        };

        document.addEventListener("click", handle, true);

        return {
            destroy() {
                clearTimeout(arm);
                document.removeEventListener("click", handle, true);
            },
        };
    }

    onMount(() => {
        // A modal is expected to take focus. The first input is not bound directly
        // because it depends on which rows survive the filter.
        panelEl?.querySelector<HTMLInputElement>(".cogs-list input")?.focus();

        function onKeydown(event: KeyboardEvent) {
            if (event.key === "Escape") onClose();
        }
        window.addEventListener("keydown", onKeydown);

        return () => window.removeEventListener("keydown", onKeydown);
    });
</script>

<div class="cogs-backdrop" role="presentation">
    <div
        class="cogs-panel glass-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cogs-title"
        tabindex="-1"
        use:clickOutside
        bind:this={panelEl}
    >
        <div class="cogs-head">
            <h2 id="cogs-title">Себестоимость</h2>
            <button type="button" class="icon-btn" onclick={onClose} aria-label="Закрыть">
                ✕
            </button>
        </div>

        <p class="cogs-summary">
            Задано <strong>{known.length}</strong> из {products.length} позиций.
            {#if known.length < products.length}
                Пока себестоимость неизвестна, маржа по товару не считается — мы не
                подставляем ноль, потому что «нет данных» и «нет прибыли» — разное.
            {/if}
        </p>

        <label class="cogs-filter">
            <span>Поиск</span>
            <input type="search" bind:value={filter} placeholder="артикул или название" />
        </label>

        <div class="cogs-list">
            {#if visible.length === 0}
                <p class="muted">Ничего не найдено.</p>
            {:else}
                {#each visible as item (item.key)}
                    <div class="cogs-row">
                        <div class="cogs-name">
                            <span class="cogs-label" title={item.label}>{item.label}</span>
                            <span class="cogs-key">{item.key}</span>
                        </div>
                        <span class="cogs-sold">
                            {item.units} шт · {formatCurrency(item.payout)}
                        </span>
                        <label class="cogs-input">
                            <span class="sr-only">Себестоимость за единицу, {item.key}</span>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                inputmode="decimal"
                                value={currentCost(item.key)}
                                placeholder="—"
                                onchange={(event) =>
                                    commit(item.key, event.currentTarget.value)}
                            />
                            <span class="cogs-unit">₽/шт</span>
                        </label>
                    </div>
                {/each}
            {/if}
        </div>

        <div class="cogs-import">
            <label for="cogs-import-text">
                Импорт и экспорт: по строке на товар, «артикул;себестоимость»
            </label>
            <textarea
                id="cogs-import-text"
                rows="4"
                bind:value={importText}
                placeholder="ART-1;1000,50&#10;ART-2;250"
            ></textarea>
            <div class="cogs-actions">
                <button type="button" class="btn" onclick={handleImport}>Импортировать</button>
                <button type="button" class="btn" onclick={handleExport}>Выгрузить</button>
                <button
                    type="button"
                    class="btn danger"
                    onclick={() => {
                        clearCosts();
                        importNote = "Себестоимость очищена.";
                    }}
                >
                    Очистить всё
                </button>
            </div>
            {#if importNote}
                <p class="cogs-note" role="status">{importNote}</p>
            {/if}
        </div>
    </div>
</div>

<style>
    .cogs-backdrop {
        position: fixed;
        inset: 0;
        z-index: 200;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: clamp(12px, 4vh, 48px) 12px;
        background: rgba(0, 0, 0, 0.72);
        backdrop-filter: blur(4px);
        overflow-y: auto;
    }

    .cogs-panel {
        width: min(680px, 100%);
        padding: var(--space-lg);
        background: var(--bg-card);
        border-radius: var(--radius-md);
    }

    .cogs-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-md);
    }

    h2 {
        margin: 0;
        font-family: var(--font-heading);
        font-size: 1.1rem;
        color: var(--text-primary);
    }

    .icon-btn {
        background: transparent;
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        border-radius: var(--radius-sm);
        min-width: 36px;
        min-height: 36px;
        cursor: pointer;
    }

    .icon-btn:hover {
        color: var(--text-primary);
        border-color: var(--border-hover);
    }

    .cogs-summary {
        margin: var(--space-md) 0;
        font-size: 0.8rem;
        color: var(--text-secondary);
        line-height: 1.5;
    }

    .cogs-filter {
        display: flex;
        align-items: center;
        gap: var(--space-sm);
        margin-bottom: var(--space-md);
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-muted);
    }

    .cogs-filter input {
        flex: 1 1 auto;
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        padding: 8px 10px;
        font-size: 0.85rem;
        font-family: inherit;
    }

    .cogs-filter input:focus-visible {
        outline: 2px solid var(--accent-gold);
        outline-offset: 1px;
    }

    .cogs-list {
        max-height: 44vh;
        overflow-y: auto;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
    }

    .cogs-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        align-items: center;
        gap: var(--space-md);
        padding: 8px var(--space-md);
        border-bottom: 1px solid var(--border-subtle);
    }

    .cogs-row:last-child {
        border-bottom: none;
    }

    .cogs-name {
        min-width: 0;
    }

    .cogs-label {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.85rem;
        color: var(--text-primary);
    }

    .cogs-key {
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .cogs-sold {
        font-size: 0.72rem;
        color: var(--text-muted);
        white-space: nowrap;
    }

    .cogs-input {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }

    .cogs-input input {
        width: 96px;
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        padding: 8px 10px;
        font-size: 0.85rem;
        font-family: inherit;
        text-align: right;
    }

    .cogs-input input:focus-visible {
        outline: 2px solid var(--accent-gold);
        outline-offset: 1px;
    }

    .cogs-unit {
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .cogs-import {
        margin-top: var(--space-lg);
    }

    .cogs-import label {
        display: block;
        font-size: 0.7rem;
        color: var(--text-muted);
        margin-bottom: 6px;
    }

    textarea {
        width: 100%;
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        padding: 10px;
        font-family: ui-monospace, monospace;
        font-size: 0.8rem;
        resize: vertical;
    }

    textarea:focus-visible {
        outline: 2px solid var(--accent-gold);
        outline-offset: 1px;
    }

    .cogs-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-sm);
        margin-top: var(--space-sm);
    }

    .btn {
        background: transparent;
        border: 1px solid var(--border-hover);
        color: var(--text-primary);
        padding: 8px 14px;
        min-height: 40px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-family: inherit;
        font-size: 0.78rem;
        font-weight: 600;
    }

    .btn:hover {
        background: rgba(255, 255, 255, 0.06);
    }

    .btn.danger {
        border-color: rgba(239, 68, 68, 0.4);
        color: #f87171;
    }

    .cogs-note {
        margin: var(--space-sm) 0 0;
        font-size: 0.75rem;
        color: var(--success);
    }

    .muted {
        margin: 0;
        padding: var(--space-md);
        color: var(--text-muted);
        font-size: 0.85rem;
    }
</style>
