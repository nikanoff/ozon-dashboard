import { onDestroy } from 'svelte';
import { ozonKeys } from './stores/ozon_keys';

/**
 * Calls `refresh` whenever the Ozon credentials actually change, coalescing rapid
 * edits (typing in the settings panel). The value present at setup time is ignored
 * because the caller already fetches on init.
 */
export function refreshOnKeysChange(refresh: () => void, delay = 400) {
    let previous: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = ozonKeys.subscribe(({ clientId, apiKey }) => {
        const signature = `${clientId}|${apiKey}`;

        if (previous === null) {
            previous = signature;
            return;
        }

        if (previous === signature) return;
        previous = signature;

        clearTimeout(timer);
        timer = setTimeout(refresh, delay);
    });

    onDestroy(() => {
        clearTimeout(timer);
        unsubscribe();
    });
}
