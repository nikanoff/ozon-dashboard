<script lang="ts">
    import { monthLabel } from "$lib/period";

    /**
     * Picks the calendar month every money section reports on.
     *
     * A month and nothing else: the realization report and the accrual statements are
     * monthly documents, so a trailing window can never be reconciled against them. There
     * used to be a rolling mode beside this, and it was removed once the month view covered
     * what it was for.
     */
    interface Props {
        month: string;
        /** `YYYY-MM`, newest first. */
        months: string[];
    }

    let { month = $bindable(), months }: Props = $props();
</script>

<div class="period-picker">
    <label class="month">
        <span class="sr-only">Календарный месяц</span>
        <select bind:value={month}>
            {#each months as key (key)}
                <option value={key}>{monthLabel(key)}</option>
            {/each}
        </select>
    </label>
</div>

<style>
    .period-picker {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-sm);
    }

    .month select {
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-family: inherit;
        font-size: 0.82rem;
        font-weight: 600;
        padding: 8px 10px;
        min-height: 38px;
        min-width: 180px;
        cursor: pointer;
    }

    .month select:hover {
        border-color: var(--border-hover);
    }

    .month select:focus-visible {
        outline: 2px solid var(--accent-gold);
        outline-offset: 1px;
    }
</style>
