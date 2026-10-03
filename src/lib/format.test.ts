import { describe, expect, it } from 'vitest';
import {
    formatCurrency,
    formatCurrencyParts,
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
