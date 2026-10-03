import { describe, expect, it } from 'vitest';
import {
    costAt,
    isoDay,
    mergeCosts,
    parseCostList,
    removeCost,
    setCost,
    toCostList
} from './costs';

describe('isoDay', () => {
    it('formats a local calendar day, not a UTC one', () => {
        expect(isoDay(new Date(2026, 8, 16, 23, 30))).toBe('2026-09-16');
        expect(isoDay(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
    });
});

describe('setCost', () => {
    it('adds a dated point', () => {
        const book = setCost({}, 'ART', 500, '2026-08-01');

        expect(book.ART).toEqual([{ from: '2026-08-01', unitCost: 500 }]);
    });

    it('replaces the point for the same day instead of duplicating it', () => {
        const book = setCost(setCost({}, 'ART', 500, '2026-08-01'), 'ART', 550, '2026-08-01');

        expect(book.ART).toEqual([{ from: '2026-08-01', unitCost: 550 }]);
    });

    it('keeps earlier points, so history survives an edit', () => {
        const book = setCost(setCost({}, 'ART', 500, '2026-08-01'), 'ART', 600, '2026-09-01');

        expect(book.ART).toEqual([
            { from: '2026-08-01', unitCost: 500 },
            { from: '2026-09-01', unitCost: 600 }
        ]);
    });

    it('ignores a missing key or a negative cost', () => {
        expect(setCost({}, '', 100)).toEqual({});
        expect(setCost({}, 'ART', -1)).toEqual({});
        expect(setCost({}, 'ART', Number.NaN)).toEqual({});
    });

    it('accepts zero, which is a real cost for a promo item', () => {
        expect(setCost({}, 'ART', 0, '2026-08-01').ART).toEqual([
            { from: '2026-08-01', unitCost: 0 }
        ]);
    });

    it('does not mutate the book it is given', () => {
        const before = setCost({}, 'ART', 500, '2026-08-01');
        const after = setCost(before, 'ART', 600, '2026-09-01');

        expect(before.ART).toHaveLength(1);
        expect(after.ART).toHaveLength(2);
    });
});

describe('costAt', () => {
    const book = setCost(setCost({}, 'ART', 500, '2026-08-01'), 'ART', 600, '2026-09-01');

    it('uses the point that applied on that day', () => {
        expect(costAt(book, 'ART', '2026-08-15')).toEqual({ unitCost: 500, exact: true });
        expect(costAt(book, 'ART', '2026-09-15')).toEqual({ unitCost: 600, exact: true });
    });

    it('treats the start day itself as covered', () => {
        expect(costAt(book, 'ART', '2026-09-01')).toEqual({ unitCost: 600, exact: true });
    });

    it('carries the earliest cost backwards but says it is not exact', () => {
        expect(costAt(book, 'ART', '2026-07-01')).toEqual({ unitCost: 500, exact: false });
    });

    it('accepts a Date as well as a day string', () => {
        expect(costAt(book, 'ART', new Date(2026, 7, 15))?.unitCost).toBe(500);
    });

    it('is undefined for an unknown product or an unparseable date', () => {
        expect(costAt(book, 'OTHER', '2026-09-15')).toBeUndefined();
        expect(costAt(book, 'ART', 'not-a-date')).toBeUndefined();
    });

    it('is undefined for an empty history', () => {
        expect(costAt({ ART: [] }, 'ART', '2026-09-15')).toBeUndefined();
    });
});

describe('removeCost', () => {
    it('drops the whole history for one product', () => {
        const book = setCost(setCost({}, 'ART', 500, '2026-08-01'), 'OTHER', 10, '2026-08-01');

        expect(removeCost(book, 'ART')).toEqual({ OTHER: [{ from: '2026-08-01', unitCost: 10 }] });
    });

    it('returns the same book when there is nothing to remove', () => {
        const book = setCost({}, 'ART', 500, '2026-08-01');

        expect(removeCost(book, 'MISSING')).toBe(book);
    });
});

describe('mergeCosts', () => {
    it('writes every entry on one day', () => {
        const book = mergeCosts({}, [
            { key: 'A', unitCost: 100 },
            { key: 'B', unitCost: 200 }
        ], '2026-09-01');

        expect(book).toEqual({
            A: [{ from: '2026-09-01', unitCost: 100 }],
            B: [{ from: '2026-09-01', unitCost: 200 }]
        });
    });
});

describe('parseCostList', () => {
    it('reads semicolon-separated lines with comma decimals', () => {
        const { costs, skipped } = parseCostList('ART-1;1000,50\nART-2;250\n');

        expect(costs).toEqual([
            { key: 'ART-1', unitCost: 1000.5 },
            { key: 'ART-2', unitCost: 250 }
        ]);
        expect(skipped).toEqual([]);
    });

    it('reads comma-separated lines with dot decimals', () => {
        const { costs } = parseCostList('ART-1,1000.50');

        expect(costs).toEqual([{ key: 'ART-1', unitCost: 1000.5 }]);
    });

    it('reads tab-separated lines', () => {
        const { costs } = parseCostList('ART-1\t99');

        expect(costs).toEqual([{ key: 'ART-1', unitCost: 99 }]);
    });

    it('skips a header row instead of importing it as a product', () => {
        const { costs } = parseCostList('Артикул;Себестоимость\nART-1;100');

        expect(costs).toEqual([{ key: 'ART-1', unitCost: 100 }]);
    });

    it('reports unreadable lines instead of guessing', () => {
        const { costs, skipped } = parseCostList('ART-1;100\nbroken\nART-2;abc\n;500');

        expect(costs).toEqual([{ key: 'ART-1', unitCost: 100 }]);
        expect(skipped.map((entry) => entry.line)).toEqual([2, 3, 4]);
    });

    it('ignores blank lines and comments', () => {
        const { costs, skipped } = parseCostList('\n# комментарий\nART-1;100\n\n');

        expect(costs).toEqual([{ key: 'ART-1', unitCost: 100 }]);
        expect(skipped).toEqual([]);
    });

    it('strips quotes around fields', () => {
        const { costs } = parseCostList('"ART-1";"100"');

        expect(costs).toEqual([{ key: 'ART-1', unitCost: 100 }]);
    });

    it('accepts non-breaking spaces as thousand separators', () => {
        const { costs } = parseCostList('ART-1;1 000\u00a0500');

        expect(costs).toEqual([{ key: 'ART-1', unitCost: 1000500 }]);
    });

    it('is empty-safe', () => {
        expect(parseCostList('')).toEqual({ costs: [], skipped: [] });
    });
});

describe('toCostList', () => {
    it('round-trips through the parser, using the latest point', () => {
        const book = setCost(setCost({}, 'ART', 500, '2026-08-01'), 'ART', 600, '2026-09-01');

        expect(toCostList(book)).toBe('ART;600');
        expect(parseCostList(toCostList(book)).costs).toEqual([
            { key: 'ART', unitCost: 600 }
        ]);
    });

    it('is empty-safe', () => {
        expect(toCostList({})).toBe('');
    });
});
