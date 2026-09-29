import { writable, type Writable } from 'svelte/store';

export interface SWROptions<T> {
    dedupingInterval?: number;
    revalidateOnFocus?: boolean;
    refreshInterval?: number;  // Auto-refresh interval in ms (0 = disabled)
    initialData?: T;
}

export interface SWRMutateOptions {
    /** Skip the deduping window so a manual refresh always refetches. */
    force?: boolean;
}

export interface SWRResponse<T> {
    data: Writable<T | undefined>;
    error: Writable<any>;
    isValidating: Writable<boolean>;
    isLoading: Writable<boolean>;
    mutate: (options?: SWRMutateOptions) => Promise<void>;
    dispose: () => void;
}

const cache = new Map<string, any>();
const lastFetch = new Map<string, number>();
const inFlight = new Map<string, { promise: Promise<void>; controller: AbortController }>();

/**
 * Reads the cached payload for a key without subscribing.
 *
 * Used to fold a partial refresh into the data that is already on screen.
 */
export function peekCache<T>(key: string): T | undefined {
    return cache.get(key);
}

function isAbortError(error: unknown) {
    return (error as { name?: string } | null)?.name === 'AbortError';
}

export function useSWR<T>(
    key: string,
    fetcher: (signal: AbortSignal) => Promise<T>,
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

    /**
     * Loads the data for this key.
     *
     * `force` skips the deduping window, so a manual refresh always refetches.
     * Concurrent callers for the same key always share one request: without that,
     * the initial load and a credentials-change refresh would run the whole
     * request chain twice in parallel.
     */
    async function mutate({ force = false }: SWRMutateOptions = {}) {
        const now = Date.now();
        const last = lastFetch.get(key) || 0;

        if (!force && cache.has(key) && now - last < dedupingInterval) {
            return;
        }

        const pending = inFlight.get(key);
        if (pending) {
            // Join the request that is already running. A forced call still needs
            // its own fresh result once that one settles.
            await pending.promise.catch(() => {});
            if (!force) return;
        }

        const controller = new AbortController();
        isValidating.set(true);

        const promise = (async () => {
            try {
                const result = await fetcher(controller.signal);
                cache.set(key, result);
                lastFetch.set(key, Date.now());
                data.set(result);
                error.set(null);
            } catch (e) {
                // An abort is a teardown, not a failure worth showing the user.
                if (!isAbortError(e)) {
                    error.set(e);
                }
            } finally {
                inFlight.delete(key);
                isValidating.set(false);
                isLoading.set(false);
            }
        })();

        inFlight.set(key, { promise, controller });
        await promise;
    }

    // Initial fetch
    mutate();

    let refreshIntervalId: ReturnType<typeof setInterval> | undefined;

    if (refreshInterval > 0 && typeof window !== 'undefined') {
        refreshIntervalId = setInterval(() => {
            // Skip background tabs: nobody is looking, and Ozon's rate limits are
            // per account.
            if (document.hidden) return;
            mutate();
        }, refreshInterval);
    }

    let handleFocus: (() => void) | undefined;

    if (revalidateOnFocus && typeof window !== 'undefined') {
        handleFocus = () => mutate();
        window.addEventListener('focus', handleFocus);
    }

    const dispose = () => {
        if (handleFocus) {
            window.removeEventListener('focus', handleFocus);
        }
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
        }
        // Drop the request this component is waiting for.
        inFlight.get(key)?.controller.abort();
    };

    return {
        data,
        error,
        isValidating,
        isLoading,
        mutate,
        dispose
    };
}
