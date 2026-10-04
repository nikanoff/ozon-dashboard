<script lang="ts">
    import type { Snippet } from "svelte";
    import { placeBubble } from "$lib/tooltip_placement";

    /**
     * A metric that explains itself on hover, tap or keyboard focus.
     *
     * The cards show figures that are each a small piece of arithmetic, and a figure without
     * its arithmetic is a number to be trusted blindly. Each one therefore carries the sum
     * behind it: what was counted, what was left out, and which source it came from. The rows
     * are plain `label → value` pairs rather than markup, so every tooltip reads the same way.
     *
     * Three placements are decided when the bubble opens, because CSS cannot know them:
     *
     *   - **below or above.** A metric near the bottom of a phone screen has no room for a
     *     bubble underneath, so it opens upwards instead — otherwise the explanation would sit
     *     off-screen exactly where the reader is looking.
     *   - **sideways.** The first card would push its bubble off the left edge and the last one
     *     off the right, so it is measured and slid back inside.
     *   - **safe area.** On a phone the home indicator covers the bottom ~34 px, so the fit
     *     keeps clear of it when the pointer is coarse.
     *
     * Reveal is pure CSS. Hover is scoped to devices that really hover — on a touch screen a
     * `:hover` rule sticks after a tap and the bubble would stay open behind the reader's next
     * tap — while focus works everywhere: on a phone, tapping the metric's name focuses the
     * trigger and opens the bubble; tapping anywhere else closes it.
     */
    interface TipRow {
        label: string;
        value: string;
        /** Louder rows (the total), quieter ones (asides) and nested parts read differently. */
        tone?: "total" | "aside" | "minus" | "sub";
    }

    interface Props {
        /** The metric's own name, shown above the figure. */
        heading: string;
        /** Accessible name of the explanation trigger. */
        label: string;
        /** Heading inside the bubble. */
        title?: string;
        rows?: TipRow[];
        /** How the figure is formed, in words — the part a formula cannot say. */
        footer?: string;
        /**
         * One line under the figure, readable without opening anything.
         *
         * The card states what is worth knowing at a glance — the split behind a payout, the tax
         * inside a profit, the reason a figure is missing — and the tooltip keeps the rest.
         */
        note?: string;
        /** Set for a metric that spans the card's two columns, like the headline figure. */
        wide?: boolean;
        /** The figure itself. */
        children: Snippet;
    }

    let {
        heading,
        label,
        title,
        rows = [],
        footer,
        note,
        wide = false,
        children
    }: Props = $props();

    let host = $state<HTMLElement | null>(null);
    let bubble = $state<HTMLElement | null>(null);
    /** How far to slide the bubble, in pixels; negative moves it left. */
    let shift = $state(0);
    /** Which side of the metric the bubble opens on. */
    let above = $state(false);

    /**
     * Measures the metric and its bubble and asks the geometry where the bubble goes.
     *
     * The bubble is measured while it is still hidden: `visibility: hidden` keeps its layout, so
     * its height is known before it is shown and the decision needs no second frame.
     */
    function place() {
        if (!host || !bubble) return;

        const rect = host.getBoundingClientRect();
        const placement = placeBubble({
            host: {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom
            },
            bubble: { width: bubble.offsetWidth, height: bubble.offsetHeight },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            coarse: window.matchMedia("(pointer: coarse)").matches
        });

        shift = placement.shift;
        above = placement.above;
    }
</script>

<div
    class="metric-tip"
    data-wide={wide ? "true" : undefined}
    data-above={above ? "true" : undefined}
    bind:this={host}
    style="--shift: {shift}px"
>
    <!--
        The trigger is a button, not the whole metric: a div with a mouse handler and a
        tabindex is neither focusable by contract nor announced as anything, while a button
        both focuses and says what it is. It carries no border or background — the dashed
        underline is the only affordance the reader needs.
    -->
    <button
        type="button"
        class="metric-trigger"
        aria-label={label}
        onmouseenter={place}
        onfocus={place}
    >
        {heading}
    </button>

    {@render children()}

    {#if note}
        <span class="metric-note">{note}</span>
    {/if}

    <div class="tip-bubble" role="tooltip" bind:this={bubble}>
        <span class="tip-caret" aria-hidden="true"></span>
        {#if title}
            <span class="tip-title">{title}</span>
        {/if}
        {#if rows.length > 0}
            <span class="tip-rows">
                {#each rows as row (row.label)}
                    <span class="tip-row" data-tone={row.tone ?? "plain"}>
                        <span class="tip-row-label">{row.label}</span>
                        <span class="tip-row-value">{row.value}</span>
                    </span>
                {/each}
            </span>
        {/if}
        {#if footer}
            <span class="tip-footer">{footer}</span>
        {/if}
    </div>
</div>

<style>
    .metric-tip {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
    }

    /* The card's headline figure spans both of its columns. */
    .metric-tip[data-wide="true"] {
        grid-column: 1 / -1;
    }

    /*
        The metric's name doubles as the trigger. The dashed underline is the only affordance:
        a border or a background would turn a row of figures into a row of controls.
    */
    .metric-trigger {
        position: relative;
        align-self: flex-start;
        margin: 0;
        padding: 0;
        background: none;
        border: none;
        border-bottom: 1px dashed rgba(255, 255, 255, 0.18);
        color: var(--text-muted);
        font-family: var(--font-body);
        font-size: 0.68rem;
        font-weight: 400;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-align: left;
        /* A tap must not wait for a possible double-tap zoom. */
        touch-action: manipulation;
    }

    /*
        A finger needs a bigger target than eleven pixels of text. The hit area is grown with a
        pseudo-element rather than with padding, so the dashed underline stays where it is and
        the card's grid keeps its rhythm.
    */
    @media (pointer: coarse) {
        .metric-trigger::after {
            content: "";
            position: absolute;
            inset: -9px -8px;
        }
    }

    /* A pointer that hovers gets a hint that the name can be hovered; a finger does not. */
    @media (hover: hover) {
        .metric-trigger {
            cursor: help;
        }

        .metric-trigger:hover {
            color: var(--text-secondary);
            border-bottom-color: rgba(234, 179, 8, 0.5);
        }
    }

    .metric-trigger:focus-visible {
        outline: 2px solid rgba(234, 179, 8, 0.5);
        outline-offset: 2px;
        border-radius: 4px;
        color: var(--text-secondary);
        border-bottom-color: rgba(234, 179, 8, 0.5);
    }

    /* The glanceable line: quieter than the figure, louder than nothing. */
    .metric-note {
        font-size: var(--text-xs);
        line-height: 1.35;
        color: var(--text-muted);
    }

    .tip-bubble {
        position: absolute;
        top: calc(100% + 10px);
        left: -8px;
        z-index: 60;
        display: flex;
        flex-direction: column;
        gap: 7px;
        width: max-content;
        max-width: min(300px, 86vw);
        padding: 10px 12px;
        background: #1c1c1f;
        border: 1px solid rgba(234, 179, 8, 0.35);
        border-radius: 10px;
        box-shadow: 0 14px 34px -10px rgba(0, 0, 0, 0.85);
        color: var(--text-secondary);
        font-family: var(--font-body);
        font-size: 0.72rem;
        font-weight: 400;
        line-height: 1.4;
        letter-spacing: 0;
        text-transform: none;
        text-align: left;
        white-space: normal;
        opacity: 0;
        visibility: hidden;
        /* `--shift` is the horizontal correction measured in `place()`. */
        transform: translateX(var(--shift, 0px)) translateY(var(--enter, -6px));
        transition:
            opacity var(--transition-fast),
            transform var(--transition-fast),
            visibility var(--transition-fast);
        pointer-events: none;
        overscroll-behavior: contain;
    }

    /* Opens upwards when there is no room below; the caret flips with it. */
    .metric-tip[data-above="true"] .tip-bubble {
        top: auto;
        bottom: calc(100% + 10px);
        --enter: 6px;
    }

    .tip-caret {
        position: absolute;
        top: -5px;
        left: calc(15px - var(--shift, 0px));
        width: 9px;
        height: 9px;
        background: #1c1c1f;
        border-top: 1px solid rgba(234, 179, 8, 0.35);
        border-left: 1px solid rgba(234, 179, 8, 0.35);
        transform: rotate(45deg);
    }

    .metric-tip[data-above="true"] .tip-caret {
        top: auto;
        bottom: -5px;
        border-top: none;
        border-left: none;
        border-right: 1px solid rgba(234, 179, 8, 0.35);
        border-bottom: 1px solid rgba(234, 179, 8, 0.35);
    }

    /*
        Focus reveals everywhere — a tap on a phone focuses the trigger — while hover is left to
        devices that really hover, so a touch screen cannot leave a bubble stuck open.
    */
    .metric-tip:focus-within .tip-bubble {
        opacity: 1;
        visibility: visible;
        transform: translateX(var(--shift, 0px)) translateY(0);
    }

    @media (hover: hover) {
        .metric-tip:hover .tip-bubble {
            opacity: 1;
            visibility: visible;
            transform: translateX(var(--shift, 0px)) translateY(0);
        }
    }

    .tip-title {
        color: var(--text-primary);
        font-family: var(--font-heading);
        font-size: 0.76rem;
        font-weight: 600;
    }

    .tip-rows {
        display: flex;
        flex-direction: column;
        gap: 3px;
    }

    .tip-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
    }

    .tip-row-label {
        min-width: 0;
    }

    .tip-row-value {
        flex-shrink: 0;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        font-weight: 600;
    }

    /* The row that is the figure itself, and rows that only subtract from it. */
    .tip-row[data-tone="total"] {
        margin-top: 2px;
        padding-top: 4px;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
    }

    .tip-row[data-tone="total"] .tip-row-label,
    .tip-row[data-tone="total"] .tip-row-value {
        color: var(--text-primary);
        font-weight: 700;
    }

    .tip-row[data-tone="minus"] .tip-row-value {
        color: var(--error);
    }

    /*
        A part of the row above it, not a sibling: indented, dimmer, and never bold — so a
        breakdown reads as a hierarchy instead of a list of numbers that might all be added.
    */
    .tip-row[data-tone="sub"] {
        padding-left: 12px;
    }

    .tip-row[data-tone="sub"] .tip-row-label,
    .tip-row[data-tone="sub"] .tip-row-value {
        color: var(--text-muted);
        font-weight: 400;
    }

    .tip-row[data-tone="aside"] .tip-row-label,
    .tip-row[data-tone="aside"] .tip-row-value {
        color: var(--text-muted);
        font-weight: 400;
    }

    .tip-footer {
        padding-top: 6px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--text-muted);
    }

    /*
        A phone also has to bound the bubble vertically: some explanations run to several
        hundred characters, and at 300 px wide that is taller than the screen. Scrolling inside
        it keeps the whole text reachable, and the safe-area padding keeps the last line clear of
        the home indicator.
    */
    @media (max-width: 720px) {
        .tip-bubble {
            max-height: 60vh;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
        }

        @supports (padding: env(safe-area-inset-bottom)) {
            .tip-bubble {
                padding-bottom: calc(10px + env(safe-area-inset-bottom));
            }
        }
    }

    /* The lift and the slide are decoration; a reader who asked for less motion gets none. */
    @media (prefers-reduced-motion: reduce) {
        .tip-bubble {
            transition: none;
            transform: translateX(var(--shift, 0px));
        }
    }
</style>
