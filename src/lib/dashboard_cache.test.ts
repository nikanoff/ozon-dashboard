import { describe, expect, it } from 'vitest';
import {
    REFRESH_WINDOW_MS,
    coversWindow,
    mergeDashboardPayload,
    needsFullLoad,
    refreshSince
} from './dashboard_cache';
import type { DashboardPayload, DashboardPosting } from './ozon_types';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const OLDEST_ALLOWED = '2026-08-16T12:00:00.000Z';

function posting(postingNumber: string, createdAt: string, status = 'delivered'): DashboardPosting {
    return {
        posting_number: postingNumber,
        created_at: createdAt,
        status,
        products: [],
        financial_products: [],
        actions: []
    };
}

function payload(
    postings: DashboardPosting[],
    overrides: Partial<DashboardPayload> = {}
): DashboardPayload {
    return {
        postings,
        skuToImage: {},
        fetchedAt: new Date(NOW).toISOString(),
        oldestAllowed: OLDEST_ALLOWED,
        ...overrides
    };
}

describe('needsFullLoad', () => {
    it('loads everything when there is no payload yet', () => {
        expect(needsFullLoad(undefined, NOW)).toBe(true);
    });

    it('refreshes incrementally while the payload is inside the window', () => {
        const recent = new Date(NOW - REFRESH_WINDOW_MS + 60_000).toISOString();
        expect(needsFullLoad(payload([], { fetchedAt: recent }), NOW)).toBe(false);
    });

    it('falls back to a full load once the payload is older than the window', () => {
        const stale = new Date(NOW - REFRESH_WINDOW_MS - 60_000).toISOString();
        expect(needsFullLoad(payload([], { fetchedAt: stale }), NOW)).toBe(true);
    });

    it('treats an unparsable fetchedAt as stale', () => {
        expect(needsFullLoad(payload([], { fetchedAt: 'nonsense' }), NOW)).toBe(true);
    });
});

describe('refreshSince', () => {
    it('asks for the refresh window', () => {
        expect(refreshSince(NOW)).toBe(new Date(NOW - REFRESH_WINDOW_MS).toISOString());
    });
});

describe('coversWindow', () => {
    const payload = (ranges?: Array<{ from: string; to: string }>) =>
        ({ ranges }) as unknown as DashboardPayload;

    it('is true when a fetched range contains the window asked for', () => {
        const held = payload([{ from: '2026-09-01', to: '2026-09-30' }]);

        expect(coversWindow(held, '2026-09-01', '2026-09-30')).toBe(true);
    });

    it('is false when the range stops short of the window', () => {
        const held = payload([{ from: '2026-09-01', to: '2026-09-30' }]);

        expect(coversWindow(held, '2026-09-01', '2026-10-03')).toBe(false);
        expect(coversWindow(held, '2026-08-15', '2026-09-30')).toBe(false);
    });

    it('is false for an old month held beside a tail that misses its first day', () => {
        // The shape that produced the bug: August 2025 loaded, so the ranges are that month
        // and today's tail. Its earliest edge is 2025-08-01, which is before September and
        // made the old edge comparison claim coverage of a month starting on the 1st.
        const held = payload([
            { from: '2025-08-01', to: '2025-08-31' },
            { from: '2026-09-02', to: '2026-10-03' }
        ]);

        expect(coversWindow(held, '2026-09-01', '2026-09-30')).toBe(false);
    });

    it('is false for a payload from a build that did not report ranges', () => {
        // Treated as no coverage, which costs a full load rather than a wrong merge.
        expect(coversWindow(payload(undefined), '2026-09-01', '2026-09-30')).toBe(false);
        expect(coversWindow(undefined, '2026-09-01', '2026-09-30')).toBe(false);
    });
});

describe('mergeDashboardPayload', () => {
    const fresh = payload(
        [posting('fresh', '2026-09-15T09:00:00.000Z'), posting('shared', '2026-09-14T09:00:00.000Z', 'cancelled')],
        { fetchedAt: new Date(NOW).toISOString(), skuToImage: { 2: 'fresh.jpg' } }
    );

    it('keeps the history it already has', () => {
        const previous = payload([posting('old', '2026-08-20T09:00:00.000Z')]);
        const merged = mergeDashboardPayload(previous, fresh);

        expect(merged.postings.map((p) => p.posting_number).sort()).toEqual([
            'fresh',
            'old',
            'shared'
        ]);
    });

    it('lets the refreshed row win, since its status may have changed', () => {
        const previous = payload([
            posting('shared', '2026-09-14T09:00:00.000Z', 'delivered')
        ]);
        const merged = mergeDashboardPayload(previous, fresh);

        expect(merged.postings.find((p) => p.posting_number === 'shared')?.status).toBe('cancelled');
    });

    it('drops rows that fell out of the widest period', () => {
        const previous = payload([posting('tooOld', '2026-08-01T09:00:00.000Z')]);
        const merged = mergeDashboardPayload(previous, fresh);

        expect(merged.postings.some((p) => p.posting_number === 'tooOld')).toBe(false);
    });

    it('merges image maps, preferring the refreshed ones', () => {
        const previous = payload([], { skuToImage: { 1: 'old.jpg', 2: 'stale.jpg' } });
        const merged = mergeDashboardPayload(previous, fresh);

        expect(merged.skuToImage).toEqual({ 1: 'old.jpg', 2: 'fresh.jpg' });
    });

    it('carries the freshness of the refresh forward', () => {
        const previous = payload([], { fetchedAt: new Date(NOW - 60_000).toISOString() });
        const merged = mergeDashboardPayload(previous, fresh);

        expect(merged.fetchedAt).toBe(fresh.fetchedAt);
        expect(merged.oldestAllowed).toBe(fresh.oldestAllowed);
    });
});
