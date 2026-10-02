<script lang="ts">
    import { onMount } from "svelte";

    /**
     * Chromium fires this before showing its own install UI; capturing it lets us
     * trigger the prompt from a button instead. Not part of the DOM lib types.
     */
    interface BeforeInstallPromptEvent extends Event {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
    }

    let deferred = $state<BeforeInstallPromptEvent | null>(null);
    let standalone = $state(false);
    let isMobile = $state(false);
    let isIos = $state(false);
    let showIosHint = $state(false);

    /**
     * The button is for phones/tablets only, so it never shows on desktop Chrome
     * and Edge, which fire the same beforeinstallprompt event.
     */
    const canInstall = $derived(
        isMobile && !standalone && (deferred !== null || isIos),
    );

    /** iPadOS 13+ reports itself as macOS but is a touch-only tablet. */
    function isIosDevice(): boolean {
        const ua = navigator.userAgent;
        return (
            /iphone|ipad|ipod/i.test(ua) ||
            (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
        );
    }

    function detectMobile(): boolean {
        const { userAgentData } = navigator as Navigator & {
            userAgentData?: { mobile?: boolean };
        };
        if (typeof userAgentData?.mobile === "boolean") return userAgentData.mobile;

        return (
            /android|iphone|ipad|ipod|iemobile|opera mini|mobile/i.test(
                navigator.userAgent,
            ) || isIosDevice()
        );
    }

    onMount(() => {
        standalone =
            window.matchMedia("(display-mode: standalone)").matches ||
            (navigator as Navigator & { standalone?: boolean }).standalone === true;

        isMobile = detectMobile();

        // iOS Safari never fires beforeinstallprompt; there the install is manual.
        isIos = isIosDevice();

        function onBeforeInstall(event: Event) {
            event.preventDefault();
            deferred = event as BeforeInstallPromptEvent;
        }

        function onInstalled() {
            deferred = null;
            standalone = true;
        }

        window.addEventListener("beforeinstallprompt", onBeforeInstall);
        window.addEventListener("appinstalled", onInstalled);

        return () => {
            window.removeEventListener("beforeinstallprompt", onBeforeInstall);
            window.removeEventListener("appinstalled", onInstalled);
        };
    });

    async function handleClick() {
        if (deferred) {
            await deferred.prompt();
            const choice = await deferred.userChoice;
            // A prompt can only be used once; drop it after the user decides.
            if (choice.outcome === "accepted") deferred = null;
            return;
        }

        showIosHint = !showIosHint;
    }
</script>

{#if canInstall}
    <div class="install">
        <button
            type="button"
            class="install-btn glass"
            onclick={handleClick}
            title="Install app"
        >
            <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                stroke="currentColor"
                fill="none"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
            >
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 21h14" />
            </svg>
            Install App
        </button>

        {#if showIosHint}
            <!-- Describes localized iOS UI, so keep the wording in Russian. -->
            <div class="ios-hint glass" role="note">
                Нажмите «Поделиться» в Safari, затем выберите «На экран „Домой“».
            </div>
        {/if}
    </div>
{/if}

<style>
    .install {
        position: relative;
        display: flex;
    }

    /* Matches the header's other action buttons. */
    .install-btn {
        background: transparent;
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        padding: 0.5rem 1.25rem;
        border-radius: var(--radius-sm);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-family: inherit;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        transition: all 0.3s ease;
    }

    .install-btn:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: var(--border-hover);
        color: var(--text-primary);
    }

    .ios-hint {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        z-index: 1000;
        width: 230px;
        padding: 10px 12px;
        background: var(--bg-card);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
        color: var(--text-secondary);
        font-size: 0.7rem;
        font-weight: 400;
        line-height: 1.45;
        letter-spacing: 0;
        text-transform: none;
        text-align: left;
    }

    @media (max-width: 720px) {
        .install {
            flex: 1 1 auto;
        }

        .install-btn {
            width: 100%;
            justify-content: center;
        }

        .ios-hint {
            right: auto;
            left: 0;
        }
    }
</style>
