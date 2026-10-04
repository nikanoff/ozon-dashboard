import { describe, expect, it } from 'vitest';
import {
    formatCurrency,
    formatCurrencyParts,
    formatCurrencyPrecise,
    formatDay,
    formatDelta,
    formatNumber,
    formatPercent
} from './format';

describe('formatCurrency', () => {
    it('formats in roubles with grouped thousands', () => {
        expect(formatCurrency(1234567)).toContain('1');
        expect(formatCurrency(0)).toContain('0');
    });
});

describe('formatCurrencyPrecise', () => {
    it('keeps kopecks, so a breakdown adds up on screen', () => {
        // September 2026: the rounded parts read 149 955 − 12 742 = 137 213 against a total of
        // 137 214 ₽, a whole rouble of apparent error in arithmetic that is exact.
        const orders = 149955.5;
        const cabinet = -12741.79;

        expect(formatCurrencyPrecise(orders)).toContain('149');
        expect(formatCurrencyPrecise(orders)).toMatch(/50/);
        expect(formatCurrencyPrecise(cabinet)).toMatch(/12\D?741\D?79/);
        expect(formatCurrencyPrecise(orders + cabinet)).toBe(formatCurrencyPrecise(137213.71));
    });

    it('always shows two decimals, including on a whole rouble', () => {
        expect(formatCurrencyPrecise(1196)).toMatch(/00/);
    });
});

describe('formatCurrencyParts', () => {
    it('splits the digits from the symbol, without stray separators', () => {
        const parts = formatCurrencyParts(1234);

        expect(parts.symbol).toBe('₽');
        // No trailing space or non-breaking space left behind.
        expect(parts.amount).not.toMatch(/\s$/);
        expect(parts.amount.startsWith('1')).toBe(true);
    });

    it('keeps a negative sign with the digits', () => {
        const parts = formatCurrencyParts(-500);

        expect(parts.amount.startsWith('-')).toBe(true);
        expect(parts.symbol).toBe('₽');
    });

    it('re-assembles into the plain format', () => {
        const { amount, symbol } = formatCurrencyParts(999);
        const plain = formatCurrency(999);

        expect(plain).toContain(amount);
        expect(plain).toContain(symbol);
    });
});

describe('formatPercent', () => {
    it('uses a comma, like the rest of the russian locale', () => {
        expect(formatPercent(12.34)).toBe('12,3%');
        expect(formatPercent(100)).toBe('100,0%');
    });

    it('honours the requested precision', () => {
        expect(formatPercent(12.345, 2)).toBe('12,35%');
    });
});

describe('formatDelta', () => {
    it('signs the change and uses a comma', () => {
        expect(formatDelta(5.5)).toBe('+5,5%');
        expect(formatDelta(-0.4)).toBe('-0,4%');
        expect(formatDelta(0)).toBe('+0,0%');
    });

    it('is a dash when there is nothing to compare against', () => {
        expect(formatDelta(null)).toBe('—');
    });
});

describe('formatNumber', () => {
    it('groups thousands', () => {
        expect(formatNumber(1000)).not.toBe('1000');
        expect(formatNumber(42)).toBe('42');
    });
});

describe('formatDay', () => {
    it('turns a key into a dotted date, as the rest of the page writes them', () => {
        expect(formatDay('2026-09-01')).toBe('01.09.2026');
        expect(formatDay('2025-08-31')).toBe('31.08.2025');
    });

    it('is a dash when there is no date', () => {
        expect(formatDay(null)).toBe('—');
        expect(formatDay(undefined)).toBe('—');
        expect(formatDay('')).toBe('—');
    });

    it('passes an unrecognisable value through rather than inventing a date', () => {
        expect(formatDay('не дата')).toBe('не дата');
    });
});
