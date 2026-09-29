<script lang="ts">
    /**
     * Segmented control for the analysis window. Bindable, so the same state can
     * drive several panels (the sales trend and the hourly chart) at once.
     */
    interface Props {
        /** Selected window in days. */
        value: number;
        /** Windows offered, in days. */
        options?: number[];
        /** Accessible group label. */
        label?: string;
    }

    let {
        value = $bindable(),
        options = [7, 14, 31],
        label = "Окно периода, дней"
    }: Props = $props();
</script>

<div class="range-toggle" role="group" aria-label={label}>
    {#each options as option (option)}
        <button
            type="button"
            class:active={value === option}
            aria-pressed={value === option}
            title="{option} дн."
            onclick={() => (value = option)}>{option}</button
        >
    {/each}
</div>

<style>
    .range-toggle {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.02);
    }

    .range-toggle button {
        min-width: 34px;
        padding: 4px 8px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--text-muted);
        font-family: var(--font-body);
        font-size: 0.72rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        transition: all var(--transition-fast);
    }

    .range-toggle button:hover {
        color: var(--text-primary);
        background: rgba(255, 255, 255, 0.06);
    }

    .range-toggle button.active {
        color: #000000;
        background: var(--accent-gold);
    }
</style>
