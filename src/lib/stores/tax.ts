import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { TAX_BASE_LABELS, type TaxBase } from '$lib/realization';

/**
 * Tax settings for the "what is actually left" figure.
 *
 * The default is the regime the seller described: 7 % charged on the **realized revenue**,
 * not on the smaller sum Ozon transfers. The base stays a setting with the alternatives
 * spelled out, because the dashboard cannot know anyone else's regime and guessing it would
 * print a confident wrong number.
 *
 * `payout`   — the money Ozon transfers.
 * `realized` — the realized revenue at the seller's price; a `доходы` regime charges this.
 * `margin`   — revenue after the cost of goods, for regimes that tax profit.
 */
export interface TaxSettings {
    /** Rate in percent. */
    percent: number;
    base: TaxBase;
}

const STORAGE_KEY = 'ozon_tax_v2';
const DEFAULT: TaxSettings = { percent: 7, base: 'realized' };

export { TAX_BASE_LABELS };

function sanitise(raw: unknown): TaxSettings {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT };
    const value = raw as { percent?: unknown; base?: unknown };

    const percent =
        typeof value.percent === 'number' && Number.isFinite(value.percent)
            ? Math.min(Math.max(value.percent, 0), 60)
            : DEFAULT.percent;

    const base =
        value.base === 'payout' || value.base === 'realized' || value.base === 'margin'
            ? value.base
            : DEFAULT.base;

    return { percent, base };
}

function read(): TaxSettings {
    if (!browser) return { ...DEFAULT };

    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? sanitise(JSON.parse(raw)) : { ...DEFAULT };
    } catch {
        // A damaged value must not stop the page from rendering.
        return { ...DEFAULT };
    }
}

const store = writable<TaxSettings>(read());

if (browser) {
    store.subscribe((value) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        } catch {
            // Quota is not a reason to lose what is on screen.
        }
    });
}

export const taxSettings = {
    subscribe: store.subscribe,
    setPercent(percent: number) {
        store.update((current) => sanitise({ ...current, percent }));
    },
    setBase(base: TaxBase) {
        store.update((current) => sanitise({ ...current, base }));
    },
    /** Back to the defaults, for a reader who wants to start over. */
    reset() {
        store.set({ ...DEFAULT });
    }
};
