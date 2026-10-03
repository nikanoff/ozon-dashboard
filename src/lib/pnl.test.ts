import { describe, expect, it } from 'vitest';
import { moneyInTransit, summariseFinance } from './pnl';
import type { AccrualDaySummary } from './accruals';

function day(date: string, over: Partial<AccrualDaySummary> = {}): AccrualDaySummary {
    return {
        date,
        status: 'ok',
        net: 0,
        gross: 0,
        byType: {},
        byCategory: {},
        cabinetByType: {},
        counts: { total: 0, withPosting: 0, cabinet: 0 },
        ...over
    };
}

describe('summariseFinance', () => {
    it('separates order money from cabinet costs', () => {
        const summary = summariseFinance([
            day('2026-09-14', {
                net: 1000,
                gross: 1400,
                byType: { 301: -400 },
                cabinetByType: {},
                counts: { total: 2, withPosting: 2, cabinet: 0 }
            }),
            day('2026-09-15', {
                net: 800,
                byType: { 301: -300, 500: -100 },
                cabinetByType: { total: -100, 500: -100 },
                counts: { total: 3, withPosting: 2, cabinet: 1 }
            })
        ]);

        // A day's net already contains the cabinet's share, so the order part is
        // `net - cabinetTotal`: 800 - (-100) = 900.
        expect(summary.netOrders).toBe(1900);
        expect(summary.netCabinet).toBe(-100);
        expect(summary.net).toBe(1800);
        expect(summary.gross).toBe(1400);
        expect(summary.accrualCount).toBe(5);
    });

    it('keeps failed days out of the totals and reports them', () => {
        const summary = summariseFinance([
            day('2026-09-14', { net: 100 }),
            day('2026-09-15', { status: 'failed', error: 'obsolete method cannot be used' })
        ]);

        expect(summary.net).toBe(100);
        expect(summary.failedDays).toEqual([
            { date: '2026-09-15', error: 'obsolete method cannot be used' }
        ]);
        expect(summary.daysWithData).toBe(1);
    });

    it('treats an empty day as a fact, not as a gap', () => {
        const summary = summariseFinance([day('2026-09-14'), day('2026-09-15', { status: 'empty' })]);

        expect(summary.emptyDays).toEqual(['2026-09-15']);
        expect(summary.failedDays).toEqual([]);
    });

    it('reports the latest day that actually carries data', () => {
        const summary = summariseFinance([
            day('2026-09-14', { net: 5 }),
            day('2026-09-16', { net: 7 }),
            day('2026-09-18', { status: 'failed' })
        ]);

        expect(summary.lastDayWithData).toBe('2026-09-16');
    });

    it('has no last day when nothing arrived', () => {
        const summary = summariseFinance([day('2026-09-14', { status: 'failed' })]);

        expect(summary.lastDayWithData).toBeNull();
        expect(summary.net).toBe(0);
    });

    it('attributes order deductions net of the cabinet share', () => {
        const summary = summariseFinance([
            day('2026-09-15', {
                net: 500,
                byType: { 301: -200 },
                cabinetByType: { total: -50, 301: -50 }
            })
        ]);

        // The cabinet's share is reported apart from the orders, and a day's net already
        // contains it: 500 - (-50) = 550 for the orders, -50 for the cabinet.
        expect(summary.netOrders).toBe(550);
        expect(summary.netCabinet).toBe(-50);
        expect(summary.net).toBe(500);
    });

    it('is empty-safe', () => {
        const summary = summariseFinance([]);

        expect(summary.net).toBe(0);
        expect(summary.lastDayWithData).toBeNull();
    });
});

describe('moneyInTransit', () => {
    const NOW = new Date(2026, 8, 16, 12, 0, 0);

    const delivered = (postingNumber: string, daysAgo: number, payout: number | null) => ({
        posting_number: postingNumber,
        status: 'delivered',
        created_at: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        expectedPayout: payout
    });

    const accruedDay = (postings: string[]): AccrualDaySummary =>
        day('2026-09-15', {
            byPosting: Object.fromEntries(postings.map((posting) => [posting, 100]))
        });

    it('counts a delivered order that Ozon has not accrued for yet', () => {
        const result = moneyInTransit(
            [accruedDay(['A-1'])],
            [delivered('A-1', 3, 700), delivered('A-2', 2, 500)],
            NOW
        );

        expect(result.orders).toBe(1);
        expect(result.expectedPayout).toBe(500);
        expect(result.priced).toBe(1);
        expect(result.postingNumbers).toEqual(['A-2']);
    });

    it('stays silent when no day carries per-posting detail', () => {
        const result = moneyInTransit([day('2026-09-15')], [delivered('A-1', 1, 700)], NOW);

        // Without the detail every delivered order would look unpaid, so it reports nothing.
        expect(result.orders).toBe(0);
        expect(result.expectedPayout).toBeNull();
    });

    it('ignores orders that are not delivered yet', () => {
        const result = moneyInTransit(
            [accruedDay([])],
            [
                { ...delivered('A-1', 1, 700), status: 'delivering' },
                { ...delivered('A-2', 1, 700), status: 'cancelled' }
            ],
            NOW
        );

        expect(result.orders).toBe(0);
    });

    it('ignores orders older than the window that keeps detail', () => {
        const result = moneyInTransit(
            [accruedDay([])],
            [delivered('OLD', 40, 700), delivered('NEW', 2, 300)],
            NOW
        );

        expect(result.orders).toBe(1);
        expect(result.expectedPayout).toBe(300);
    });

    it('reports how many pending orders could be priced', () => {
        const result = moneyInTransit(
            [accruedDay([])],
            [delivered('A-1', 1, null), delivered('A-2', 1, 400)],
            NOW
        );

        expect(result.orders).toBe(2);
        expect(result.priced).toBe(1);
        expect(result.expectedPayout).toBe(400);
    });

    it('has no amount when none of the pending orders has a payout', () => {
        const result = moneyInTransit([accruedDay([])], [delivered('A-1', 1, null)], NOW);

        expect(result.expectedPayout).toBeNull();
    });

    it('lists the largest amounts first and caps the list', () => {
        const postings = Array.from({ length: 8 }, (_, index) =>
            delivered(`A-${index}`, 1, index * 100)
        );

        const result = moneyInTransit([accruedDay([])], postings, NOW);

        expect(result.postingNumbers).toHaveLength(5);
        expect(result.postingNumbers[0]).toBe('A-7');
    });

    it('is empty-safe', () => {
        const result = moneyInTransit([], [], NOW);

        expect(result.orders).toBe(0);
        expect(result.expectedPayout).toBeNull();
    });
});
