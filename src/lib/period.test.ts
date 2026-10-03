import { describe, expect, it } from 'vitest';
import {
    dayKey,
    daysOfMonth,
    isInsidePeriod,
    isValidMonthKey,
    lastCompleteMonth,
    monthKey,
    monthLabel,
    previousMonthKey
} from './period';

const NOW = new Date(2026, 8, 16, 12, 0, 0); // 16 September 2026

describe('monthKey / dayKey', () => {
    it('formats in local time', () => {
        expect(monthKey(new Date(2026, 8, 1))).toBe('2026-09');
        expect(monthKey(new Date(2026, 0, 31, 23, 59))).toBe('2026-01');
        expect(dayKey(new Date(2026, 8, 5))).toBe('2026-09-05');
    });
});

describe('isValidMonthKey', () => {
    it('accepts a month and rejects anything else', () => {
        expect(isValidMonthKey('2026-09')).toBe(true);
        expect(isValidMonthKey('2026-13')).toBe(false);
        expect(isValidMonthKey('2026-00')).toBe(false);
        expect(isValidMonthKey('2026-9')).toBe(false);
        expect(isValidMonthKey('')).toBe(false);
    });
});

describe('monthLabel', () => {
    it('names the month in russian with the year', () => {
        const label = monthLabel('2026-09');

        expect(label).toContain('2026');
        expect(label.toLowerCase()).toContain('сентябр');
    });

    it('passes an invalid key through rather than inventing a name', () => {
        expect(monthLabel('nonsense')).toBe('nonsense');
    });
});

describe('daysOfMonth', () => {
    it('lists every day of a 30-day month', () => {
        const days = daysOfMonth('2026-09');

        expect(days).toHaveLength(30);
        expect(days[0]).toBe('2026-09-01');
        expect(days.at(-1)).toBe('2026-09-30');
    });

    it('handles february in a leap year', () => {
        expect(daysOfMonth('2028-02')).toHaveLength(29);
        expect(daysOfMonth('2026-02')).toHaveLength(28);
    });

    it('is empty for an invalid key', () => {
        expect(daysOfMonth('2026-13')).toEqual([]);
    });
});

describe('previousMonthKey', () => {
    it('steps back one month, across the year boundary', () => {
        expect(previousMonthKey('2026-09')).toBe('2026-08');
        expect(previousMonthKey('2026-01')).toBe('2025-12');
        expect(previousMonthKey('2026-03')).toBe('2026-02');
    });

    it('passes an invalid key through', () => {
        expect(previousMonthKey('nonsense')).toBe('nonsense');
    });
});

describe('lastCompleteMonth', () => {
    it('is the month before the current one', () => {
        expect(lastCompleteMonth(new Date(2026, 9, 3))).toBe('2026-09');
    });

    it('crosses the year boundary', () => {
        expect(lastCompleteMonth(new Date(2026, 0, 15))).toBe('2025-12');
    });

    it('is a month that has actually closed, unlike the current one', () => {
        const now = new Date(2026, 9, 3);

        expect(lastCompleteMonth(now)).not.toBe(monthKey(now));
        // And it must be the immediately preceding month, not an older one.
        expect(previousMonthKey(monthKey(now))).toBe(lastCompleteMonth(now));
    });
});

describe('isInsidePeriod', () => {
    it('matches by local day', () => {
        const days = new Set(daysOfMonth('2026-09'));

        expect(isInsidePeriod(new Date(2026, 8, 15, 23, 0).toISOString(), days)).toBe(true);
        expect(isInsidePeriod(new Date(2026, 7, 31, 12, 0).toISOString(), days)).toBe(false);
    });

    it('rejects missing or unusable dates', () => {
        const days = new Set(['2026-09-16']);

        expect(isInsidePeriod(undefined, days)).toBe(false);
        expect(isInsidePeriod('not a date', days)).toBe(false);
    });

    it('covers the whole month, boundaries included', () => {
        const days = new Set(daysOfMonth('2026-09'));

        expect(isInsidePeriod(new Date(2026, 8, 1, 0, 0).toISOString(), days)).toBe(true);
        expect(isInsidePeriod(new Date(2026, 8, 30, 23, 59).toISOString(), days)).toBe(true);
        expect(isInsidePeriod(new Date(2026, 9, 1, 0, 0).toISOString(), days)).toBe(false);
    });

    it('is empty-safe', () => {
        expect(isInsidePeriod(NOW.toISOString(), new Set())).toBe(false);
    });
});
