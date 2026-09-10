import { writable, type Writable } from 'svelte/store';
import type { OzonApiError } from './ozon_api';

export interface SWROptions<T> {
    dedupingInterval?: number;
    revalidateOnFocus?: boolean;
    refreshInterval?: number;  // Auto-refresh interval in ms (0 = disabled)
    initialData?: T;
}

export interface SWRResponse<T> {
    data: Writable<T | undefined>;
    error: Writable<any>;
    isValidating: Writable<boolean>;
    isLoading: Writable<boolean>;
    mutate: () => Promise<void>;
    dispose?: () => void;  // Function to clean up resources
}

const cache = new Map<string, any>();
const lastFetch = new Map<string, number>();
const focusListeners = new Map<string, () => void>();  // Track focus listeners for cleanup

// Earliest timestamp at which a fetch is allowed again. Set when Ozon returns
// 429 (rate limit) so we stop hammering the API and respect Retry-After.
const blockedUntil = new Map<string, number>();

const MAX_BACKOFF_MS = 5 * 60 * 1000;  // Cap automatic retries at 5 minutes
const DEFAULT_BACKOFF_MS = 60 * 1000;  // Fallback when Retry-After is absent

function backoffDelay(error: any, attempt: number): number {
    const retryAfter = Number((error as OzonApiError)?.retryAfterMs);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(retryAfter, MAX_BACKOFF_MS);
    }
    // Exponential backoff for repeated failures without a Retry-After hint.
    return Math.min(DEFAULT_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

export function useSWR<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: SWROptions<T> = {}
): SWRResponse<T> {
    const {
        dedupingInterval = 5000,
        revalidateOnFocus = true,
        refreshInterval = 0,
        initialData
    } = options;

    const data = writable<T | undefined>(cache.get(key) || initialData);
    const error = writable<any>(null);
    const isValidating = writable(false);
    const isLoading = writable(!cache.has(key));

    let consecutiveFailures = 0;

    async function mutate() {
        const now = Date.now();
        const last = lastFetch.get(key) || 0;

        // Skip if we're waiting out a rate-limit backoff window.
        const blocked = blockedUntil.get(key) || 0;
        if (now < blocked) {
            return;
        }

        if (now - last < dedupingInterval && cache.has(key)) {
            return;
        }

        isValidating.set(true);
        try {
            const result = await fetcher();
            cache.set(key, result);
            lastFetch.set(key, now);
            data.set(result);
            error.set(null);
            consecutiveFailures = 0;
            blockedUntil.delete(key);
        } catch (e) {
            error.set(e);
            consecutiveFailures += 1;

            // Ozon signals rate limiting explicitly with 429; other errors are
            // transient (network, TLS) and also benefit from a pause.
            blockedUntil.set(key, Date.now() + backoffDelay(e, consecutiveFailures));
        } finally {
            isValidating.set(false);
            isLoading.set(false);
        }
    }

    // Initial fetch
    mutate();

    // Revalidate on focus - with proper cleanup to prevent memory leaks
    let dispose: (() => void) | undefined = undefined;
    let refreshIntervalId: ReturnType<typeof setInterval> | undefined = undefined;

    // Setup refresh interval if specified
    if (refreshInterval > 0 && typeof window !== 'undefined') {
        refreshIntervalId = setInterval(() => {
            mutate();
        }, refreshInterval);
    }

    if (revalidateOnFocus && typeof window !== 'undefined') {
        const handleFocus = () => {
            mutate();
        };
        window.addEventListener('focus', handleFocus);

        // Store the listener function for cleanup
        focusListeners.set(key, handleFocus);

        dispose = () => {
            const listener = focusListeners.get(key);
            if (listener) {
                window.removeEventListener('focus', listener);
                focusListeners.delete(key);
            }
            if (refreshIntervalId) {
                clearInterval(refreshIntervalId);
            }
        };
    } else if (refreshIntervalId) {
        // If no focus listener but we have an interval, still need dispose
        dispose = () => {
            if (refreshIntervalId) {
                clearInterval(refreshIntervalId);
            }
        };
    }

    return {
        data,
        error,
        isValidating,
        isLoading,
        mutate,
        dispose
    };

}
