<script lang="ts">
    import OzonAuth from "./OzonAuth.svelte";
    import ChristmasDecoration from "./ChristmasDecoration.svelte";
    import InstallPrompt from "./InstallPrompt.svelte";
    import { ozonKeys } from "$lib/stores/ozon_keys";

    interface Props {
        title: string;
        titleHref: string;
        /** Rendered as "<subtitle>: <client id>". */
        subtitle: string;
        navHref: string;
        navLabel: string;
        validating: boolean;
        /** Message of the last failed load, if any. */
        error?: string | null;
        onRefresh: () => void;
    }

    let {
        title,
        titleHref,
        subtitle,
        navHref,
        navLabel,
        validating,
        error = null,
        onRefresh,
    }: Props = $props();

    // The badge reports the state of the data, not just whether a request is in
    // flight: claiming "Live" over a failed load is worse than saying nothing.
    const statusText = $derived(
        error ? "Failed" : validating ? "Updating…" : "Live",
    );
</script>

<header class="header">
    <div class="header-content">
        <h1><a href={titleHref} class="title-link">{title}</a></h1>
        <p class="subtitle">
            {subtitle}: {$ozonKeys.clientId || "Not Configured"}
        </p>
        <nav class="nav-menu">
            <a href={navHref} class="nav-link">{navLabel}</a>
        </nav>
    </div>
    <div class="header-actions">
        <button
            class="btn-refresh glass"
            onclick={onRefresh}
            disabled={validating}
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
            {validating ? "Updating..." : "Refresh Data"}
        </button>
        <InstallPrompt />
        <div
            class="status-badge"
            class:loading={validating && !error}
            class:failed={Boolean(error)}
            role="status"
            aria-live="polite"
        >
            <span class="pulse" aria-hidden="true"></span>
            {statusText}
        </div>
        <OzonAuth />
    </div>

    <ChristmasDecoration />
</header>

<style>
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

    .status-badge.failed {
        border-color: rgba(239, 68, 68, 0.4);
        color: #f87171;
    }

    /* A failure is not a heartbeat: stop the pulse so the badge reads as a state. */
    .status-badge.failed .pulse {
        animation: none;
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

    /* Transparent on purpose: this button also carries the global `.glass` class. */
    .btn-refresh {
        background: transparent;
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

    @media (max-width: 720px) {
        .header {
            flex-direction: column;
            align-items: flex-start;
            gap: var(--space-md);
            padding: var(--space-lg) 0;
            margin-bottom: var(--space-xl);
        }

        .header-actions {
            width: 100%;
            flex-wrap: wrap;
            gap: var(--space-sm);
        }

        .btn-refresh {
            flex: 1 1 auto;
            justify-content: center;
            padding: 0.5rem 1rem;
        }

        .subtitle {
            margin-top: 6px;
        }

        .nav-menu {
            margin-top: 12px;
        }
    }
</style>
