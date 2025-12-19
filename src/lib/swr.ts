import { writable, type Writable } from 'svelte/store';

export interface SWROptions<T> {
    dedupingInterval?: number;
    revalidateOnFocus?: boolean;
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

export function useSWR<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: SWROptions<T> = {}
): SWRResponse<T> {
    const {
        dedupingInterval = 5000,
        revalidateOnFocus = true,
        initialData
    } = options;

    const data = writable<T | undefined>(cache.get(key) || initialData);
    const error = writable<any>(null);
    const isValidating = writable(false);
    const isLoading = writable(!cache.has(key));

    async function mutate() {
        const now = Date.now();
        const last = lastFetch.get(key) || 0;

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
        } catch (e) {
            error.set(e);
        } finally {
            isValidating.set(false);
            isLoading.set(false);
        }
    }

    // Initial fetch
    mutate();

    // Revalidate on focus - with proper cleanup to prevent memory leaks
    let dispose: (() => void) | undefined = undefined;
    if (revalidateOnFocus && typeof window !== 'undefined') {
        const handleFocus = () => {
            console.log(`[SWR] Revalidating on focus for key: ${key}`);
            mutate();
        };
        window.addEventListener('focus', handleFocus);
        console.log(`[SWR] Added focus listener for key: ${key}`);

        // Store the listener function for cleanup
        focusListeners.set(key, handleFocus);

        dispose = () => {
            const listener = focusListeners.get(key);
            if (listener) {
                window.removeEventListener('focus', listener);
                focusListeners.delete(key);
                console.log(`[SWR] Removed focus listener for key: ${key}`);
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
