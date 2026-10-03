import { describe, expect, it } from 'vitest';
import {
    cabinetFees,
    classifyFee,
    groupTotals,
    orderFees,
    summariseFinance,
    typeLabel
} from './pnl';
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

describe('classifyFee', () => {
    it('recognises the groups by Ozon wording', () => {
        expect(classifyFee('Комиссия за продажу')).toBe('commission');
        expect(classifyFee('Услуги продвижения товаров')).toBe('ads');
        expect(classifyFee('Обработка отправления')).toBe('logistics');
        expect(classifyFee('Логистика')).toBe('logistics');
        expect(classifyFee('Приём платежа')).toBe('acquiring');
        expect(classifyFee('Размещение на складе Ozon')).toBe('storage');
        expect(classifyFee('Обратная логистика при невыкупе')).toBe('returns');
        expect(classifyFee('Компенсация расходов')).toBe('compensation');
    });

    it('checks compensation before returns, so "компенсация возврата" is not a return', () => {
        expect(classifyFee('Компенсация по возврату')).toBe('compensation');
    });

    it('falls back to other instead of guessing', () => {
        expect(classifyFee('Неизвестная услуга')).toBe('other');
        expect(classifyFee('')).toBe('other');
    });
});

describe('typeLabel', () => {
    it('uses the catalogue name when there is one', () => {
        expect(typeLabel('301', { 301: 'Логистика' })).toBe('Логистика');
    });

    it('shows the raw id rather than inventing a name', () => {
        expect(typeLabel('777', {})).toBe('Тип начисления 777');
    });
});

describe('orderFees', () => {
    it('attributes a fee type that appears on both sides, instead of dumping it in one', () => {
        const lines = orderFees(
            { 301: -300, 1100: -50 },
            { 301: -100 },
            { 301: 'Логистика', 1100: 'Приём платежа' }
        );

        const byKey = Object.fromEntries(lines.map((line) => [line.key, line.amount]));
        expect(byKey['301']).toBe(-200);
        expect(byKey['1100']).toBe(-50);
    });

    it('ignores the cabinet pseudo-total, which is not a fee type', () => {
        const lines = orderFees({ 301: -100 }, { total: -100, 301: -100 }, {});

        expect(lines).toEqual([]);
    });

    it('sorts by size, so the largest deduction reads first', () => {
        const lines = orderFees({ a: -1, b: -500 }, {}, {});

        expect(lines[0].key).toBe('b');
    });
});

describe('cabinetFees', () => {
    it('lists the cabinet costs and hides the pseudo-total', () => {
        const lines = cabinetFees({ total: -2500, 500: -2100, 501: -400 }, { 500: 'Хранение' });

        expect(lines.map((line) => line.key)).toEqual(['500', '501']);
        expect(lines[0].group).toBe('storage');
    });
});

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
        const summary = summariseFinance(
            [
                day('2026-09-15', {
                    net: 500,
                    byType: { 301: -200 },
                    cabinetByType: { total: -50, 301: -50 }
                })
            ],
            { 301: 'Логистика' }
        );

        expect(summary.orderLines).toEqual([
            { key: '301', label: 'Логистика', amount: -150, group: 'logistics' }
        ]);
        expect(summary.cabinetLines).toEqual([
            { key: '301', label: 'Логистика', amount: -50, group: 'logistics' }
        ]);
    });

    it('is empty-safe', () => {
        const summary = summariseFinance([]);

        expect(summary.net).toBe(0);
        expect(summary.orderLines).toEqual([]);
        expect(summary.lastDayWithData).toBeNull();
    });
});

describe('groupTotals', () => {
    it('rolls lines into the bridge groups in reading order', () => {
        const totals = groupTotals([
            { key: '1', label: 'Комиссия', amount: -100, group: 'commission' },
            { key: '2', label: 'Логистика', amount: -60, group: 'logistics' },
            { key: '3', label: 'Обработка отправления', amount: -40, group: 'logistics' },
            { key: '4', label: 'Хранение', amount: -10, group: 'storage' }
        ]);

        expect(totals).toEqual([
            { group: 'commission', amount: -100 },
            { group: 'logistics', amount: -100 },
            { group: 'storage', amount: -10 }
        ]);
    });

    it('omits groups that net to zero', () => {
        expect(groupTotals([{ key: '1', label: 'x', amount: 0, group: 'ads' }])).toEqual([]);
    });
});
