import { writable, type Writable } from 'svelte/store';
import { isProgrammingError } from './failures';

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
    /**
     * Forgets this key entirely — cached payload, in-flight request and the
     * stores the caller is reading — so the next `mutate` is a fresh first load.
     */
    reset: () => void;
    dispose: () => void;
}

const cache = new Map<string, any>();
const lastFetch = new Map<string, number>();

interface InFlight {
    promise: Promise<void>;
    controller: AbortController;
    /**
     * Clears this request's in-progress flags. Called by the request itself and,
     * when the entry is evicted mid-flight, by `reset`. Idempotent.
     */
    release: () => void;
}

const inFlight = new Map<string, InFlight>();

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
        // Identifies this request, so a response that lands after `reset` evicted
        // the entry is discarded instead of resurrecting the stale payload.
        const entry: InFlight = {
            controller,
            promise: Promise.resolve(),
            release: () => {
                isValidating.set(false);
                isLoading.set(false);
            }
        };
        const isCurrent = () => inFlight.get(key) === entry;

        isValidating.set(true);

        entry.promise = (async () => {
            try {
                const result = await fetcher(controller.signal);
                if (!isCurrent()) return;

                cache.set(key, result);
                lastFetch.set(key, Date.now());
                data.set(result);
                error.set(null);
            } catch (e) {
                // An abort is a teardown, not a failure worth showing the user.
                if (!isAbortError(e) && isCurrent()) {
                    error.set(e);

                    // A programming error is reported to the reader in plain language, so the
                    // original text has to be kept somewhere it can be acted on. This is that
                    // place: the console, next to the stack.
                    if (isProgrammingError(e)) {
                        console.error(`[${key}] запрос упал из-за ошибки в коде:`, e);
                    }
                }
            } finally {
                // Only the live request owns the flags; after an eviction a newer
                // request may already have claimed them.
                if (isCurrent()) {
                    inFlight.delete(key);
                    entry.release();
                }
            }
        })();

        inFlight.set(key, entry);
        await entry.promise;
    }

    /**
     * Drops this key's payload and any request in flight for it, then puts the
     * stores back into the "first load" state.
     *
     * The key is captured when the component mounts, so it cannot follow a
     * credentials change on its own. Resetting is what keeps the account scoping
     * honest at runtime: the payload of the previous account is discarded *before*
     * the next request starts, so it can neither stay on screen nor be merged into
     * the new account's data.
     */
    function reset() {
        inFlight.get(key)?.controller.abort();
        inFlight.delete(key);

        cache.delete(key);
        lastFetch.delete(key);

        data.set(initialData);
        error.set(null);
        isValidating.set(false);
        isLoading.set(true);
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
        reset,
        dispose
    };
}
