import { get, writable } from 'svelte/store';
import { browser } from '$app/environment';
import {
    type CostBook,
    type CostPoint,
    mergeCosts,
    parseCostList,
    setCost,
    toCostList
} from '../costs';

/**
 * The seller's own purchase prices, kept in the browser next to the API keys.
 *
 * Ozon never sees a cost price, so it is the one input the dashboard cannot fetch.
 * Storing it locally matches how the credentials are handled: nothing leaves the
 * device, and the server stays free of seller data.
 *
 * Persistence is defensive on purpose — a corrupt or half-written entry must not stop
 * the page from rendering, so anything unusable is discarded rather than thrown.
 */

const STORAGE_KEY = 'ozon_cogs';

/** Keeps only well-formed points, so a damaged entry cannot break the arithmetic. */
function sanitise(value: unknown): CostBook {
    if (!value || typeof value !== 'object') return {};

    const book: CostBook = {};

    for (const [key, points] of Object.entries(value as Record<string, unknown>)) {
        if (!key || !Array.isArray(points)) continue;

        const valid = points.filter(
            (point): point is CostPoint =>
                Boolean(point) &&
                typeof point === 'object' &&
                typeof (point as CostPoint).from === 'string' &&
                Number.isFinite((point as CostPoint).unitCost)
        );

        if (valid.length > 0) {
            book[key] = [...valid].sort((a, b) => a.from.localeCompare(b.from));
        }
    }

    return book;
}

function read(): CostBook {
    if (!browser) return {};

    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? sanitise(JSON.parse(raw)) : {};
    } catch {
        return {};
    }
}

export const costBook = writable<CostBook>(read());

if (browser) {
    costBook.subscribe((value) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        } catch {
            // A full quota must not break the dashboard; the cost stays in memory.
        }
    });
}

/** Sets the current cost of one product, keeping earlier values for older periods. */
export function recordCost(key: string, unitCost: number, from?: string) {
    costBook.update((book) => setCost(book, key, unitCost, from));
}

/** Drops the entire book, for a "clear all" action. */
export function clearCosts() {
    costBook.set({});
}

export interface ImportResult {
    imported: number;
    skipped: { line: number; text: string }[];
}

/** Merges a pasted or uploaded list. Returns what was read and what was not. */
export function importCosts(text: string, from?: string): ImportResult {
    const { costs, skipped } = parseCostList(text);

    if (costs.length > 0) {
        costBook.update((book) => mergeCosts(book, costs, from));
    }

    return { imported: costs.length, skipped };
}

/** The book as a `;`-separated list, ready to paste into a spreadsheet. */
export function exportCosts(): string {
    return toCostList(get(costBook));
}
