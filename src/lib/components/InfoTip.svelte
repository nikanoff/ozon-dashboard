<script lang="ts">
    /**
     * A small info icon that reveals an explanation bubble on hover or keyboard
     * focus. Pure CSS (no state), so it stays out of the way — and it works on
     * touch via the focus state.
     */
    interface Props {
        /** Explanation shown in the bubble. */
        text: string;
        /** Accessible name for the trigger. */
        label?: string;
    }

    let { text, label = "Пояснение" }: Props = $props();
</script>

<span class="info-tip" tabindex="0" role="button" aria-label={label}>
    <svg
        class="info-icon"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        aria-hidden="true"
    >
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="11" x2="12" y2="16.4" />
        <circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none" />
    </svg>
    <span class="info-bubble" role="tooltip">
        <span class="info-caret" aria-hidden="true"></span>
        {text}
    </span>
</span>

<style>
    .info-tip {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        outline: none;
        cursor: help;
        color: var(--text-muted);
        transition:
            color var(--transition-fast),
            background-color var(--transition-fast),
            box-shadow var(--transition-fast);
    }

    .info-tip:hover,
    .info-tip:focus-visible {
        color: var(--accent-gold);
        background-color: rgba(234, 179, 8, 0.12);
        box-shadow: 0 0 0 1px rgba(234, 179, 8, 0.35);
    }

    .info-tip:focus-visible {
        outline: 2px solid rgba(234, 179, 8, 0.5);
        outline-offset: 2px;
    }

    .info-icon {
        display: block;
    }

    .info-bubble {
        position: absolute;
        top: calc(100% + 10px);
        left: -8px;
        z-index: 60;
        width: max-content;
        max-width: min(280px, 78vw);
        padding: 10px 13px;
        background: #1c1c1f;
        border: 1px solid rgba(234, 179, 8, 0.35);
        border-radius: 10px;
        box-shadow: 0 14px 34px -10px rgba(0, 0, 0, 0.85);
        color: var(--text-secondary);
        /* Reset inherited heading styles (the icon often sits in a title). */
        font-family: var(--font-body);
        font-size: 0.72rem;
        font-weight: 400;
        font-style: normal;
        line-height: 1.45;
        letter-spacing: 0;
        text-transform: none;
        text-align: left;
        white-space: normal;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-6px);
        transition:
            opacity var(--transition-fast),
            transform var(--transition-fast),
            visibility var(--transition-fast);
        pointer-events: none;
    }

    /* Small arrow pointing back at the icon. */
    .info-caret {
        position: absolute;
        top: -5px;
        left: 15px;
        width: 9px;
        height: 9px;
        background: #1c1c1f;
        border-top: 1px solid rgba(234, 179, 8, 0.35);
        border-left: 1px solid rgba(234, 179, 8, 0.35);
        transform: rotate(45deg);
    }

    .info-tip:hover .info-bubble,
    .info-tip:focus .info-bubble,
    .info-tip:focus-within .info-bubble {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
    }
</style>
