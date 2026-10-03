<script lang="ts">
    import { ozonKeys } from "$lib/stores/ozon_keys";
    import { slide } from "svelte/transition";

    let showSettings = $state(false);

    function clickOutside(node: HTMLElement) {
        const handleClick = (event: MouseEvent) => {
            if (showSettings && node && !node.contains(event.target as Node)) {
                showSettings = false;
            }
        };

        document.addEventListener("click", handleClick, true);

        return {
            destroy() {
                document.removeEventListener("click", handleClick, true);
            },
        };
    }
</script>

<div class="auth-settings" use:clickOutside>
    <button
        class="auth-toggle"
        onclick={() => (showSettings = !showSettings)}
        title="Client ID и API Key"
        aria-label="Client ID и API Key"
        aria-expanded={showSettings}
    >
        <!--
            A key, and the word for it. The previous mark was a circle with a stroke through
            it — a power symbol to most eyes — over fields that take an account id and a key,
            so nothing about it said what it opened.
        -->
        <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <circle cx="8" cy="15" r="4" />
            <path d="M10.85 12.15 19 4M18 5l2 2M15 8l2 2" />
        </svg>
        <span class="auth-label">API</span>
    </button>

    {#if showSettings}
        <div
            class="settings-panel glass"
            transition:slide={{ axis: "y", duration: 300 }}
        >
            <div class="input-group">
                <label for="client-id">Client ID</label>
                <input
                    id="client-id"
                    type="text"
                    bind:value={$ozonKeys.clientId}
                    placeholder="Enter Client ID"
                />
            </div>
            <div class="input-group">
                <label for="api-key">API Key</label>
                <input
                    id="api-key"
                    type="password"
                    bind:value={$ozonKeys.apiKey}
                    placeholder="Enter API Key"
                />
            </div>
            <p class="hint">Stored locally in your browser</p>
        </div>
    {/if}
</div>

<style>
    .auth-settings {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
    }

    .auth-toggle {
        background: transparent;
        border: 1px solid var(--border-subtle);
        color: var(--text-muted);
        padding: 8px 10px;
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: all 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        font-family: inherit;
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.06em;
    }

    /* Reads as a label for the key beside it, not as a second glyph. */
    .auth-label {
        line-height: 1;
    }

    .auth-toggle:hover {
        color: var(--text-primary);
        border-color: var(--border-hover);
        background: rgba(255, 255, 255, 0.03);
    }

    .settings-panel {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        width: 240px;
        padding: 16px;
        background: var(--bg-card);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        z-index: 1000;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }

    .input-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .input-group label {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--text-muted);
        font-weight: 700;
    }

    .input-group input {
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid var(--border-subtle);
        color: var(--text-primary);
        padding: 6px 10px;
        font-size: 0.75rem;
        border-radius: var(--radius-sm);
        outline: none;
        transition: border-color var(--transition-fast);
    }

    .input-group input:focus {
        border-color: var(--accent-gold);
    }

    .hint {
        font-size: 0.55rem;
        color: var(--text-muted);
        text-align: center;
        margin: 0;
        font-style: italic;
    }

    .glass {
        backdrop-filter: blur(12px);
    }
</style>
