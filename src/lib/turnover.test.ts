import { describe, expect, it } from 'vitest';
import {
    gradeLabel,
    isTruncated,
    summariseTurnover,
    toTurnoverRows,
    type TurnoverRow
} from './turnover';

describe('toTurnoverRows', () => {
    it('reads the documented shape', () => {
        const rows = toTurnoverRows({
            items: [
                {
                    sku: 99000001,
                    current_stock: 12,
                    ads: 1.5,
                    idc: 8,
                    turnover_grade: 'DEFICIT',
                    turnover_grade_cluster: 'DEFICIT_GROWING'
                }
            ]
        });

        expect(rows).toEqual([
            {
                sku: 99000001,
                stock: 12,
                ads: 1.5,
                idc: 8,
                grade: 'DEFICIT',
                gradeCluster: 'DEFICIT_GROWING'
            }
        ]);
    });

    it('accepts the alternative grade field and the enveloped items list', () => {
        const rows = toTurnoverRows({
            result: { items: [{ sku: 7, idc_grade: 'GRADES_RED' }] }
        });

        expect(rows[0].grade).toBe('GRADES_RED');
        expect(rows[0].stock).toBeNull();
    });

    it('accepts alternative names for the numbers', () => {
        const rows = toTurnoverRows({
            items: [{ sku: '8', stock: '5', average_daily_sales: '0,5', days_of_cover: '10' }]
        });

        expect(rows[0]).toMatchObject({ sku: 8, stock: 5, ads: 0.5, idc: 10 });
    });

    it('drops a row without a SKU, because nothing can be joined to it', () => {
        expect(toTurnoverRows({ items: [{ current_stock: 5 }] })).toEqual([]);
    });

    it('keeps a row that only carries a grade', () => {
        const rows = toTurnoverRows({ items: [{ sku: 1, turnover_grade: 'NO_SALES' }] });

        expect(rows).toHaveLength(1);
        expect(rows[0].idc).toBeNull();
    });

    it('returns nothing rather than zeros when the shape is unrecognised', () => {
        expect(toTurnoverRows(null)).toEqual([]);
        expect(toTurnoverRows({})).toEqual([]);
        expect(toTurnoverRows({ items: 'nonsense' })).toEqual([]);
        expect(toTurnoverRows([{ sku: 1 }])).toEqual([]);
    });
});

describe('gradeLabel', () => {
    it('translates the grades the documentation shows', () => {
        expect(gradeLabel('DEFICIT')).toBe('Дефицит');
        expect(gradeLabel('NO_SALES')).toBe('Нет продаж');
        expect(gradeLabel('GRADES_CRITICAL')).toBe('Критично');
    });

    it('shows an unknown grade as it arrived, rather than a blank', () => {
        expect(gradeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    });

    it('is null when there is no grade', () => {
        expect(gradeLabel(null)).toBeNull();
    });
});

describe('isTruncated', () => {
    it('detects a partial page', () => {
        expect(isTruncated({ items: [{ sku: 1 }], total: 500 })).toBe(true);
        expect(isTruncated({ items: [{ sku: 1 }], has_next: true })).toBe(true);
    });

    it('is false when everything was returned', () => {
        expect(isTruncated({ items: [{ sku: 1 }], total: 1 })).toBe(false);
        expect(isTruncated({ items: [{ sku: 1 }] })).toBe(false);
    });
});

describe('summariseTurnover', () => {
    const row = (over: Partial<TurnoverRow>): TurnoverRow => ({
        sku: 1,
        stock: 10,
        ads: 1,
        idc: 10,
        grade: 'OPTIMAL',
        gradeCluster: null,
        ...over
    });

    it('separates deficit and no-sales rows', () => {
        const summary = summariseTurnover([
            row({ sku: 1, grade: 'DEFICIT', idc: 3 }),
            row({ sku: 2, grade: 'NO_SALES', idc: null }),
            row({ sku: 3, grade: 'OPTIMAL', idc: 40 })
        ]);

        expect(summary.deficit.map((entry) => entry.sku)).toEqual([1]);
        expect(summary.noSales.map((entry) => entry.sku)).toEqual([2]);
        expect(summary.graded).toBe(3);
    });

    it('treats the alternative enum as deficit too', () => {
        const summary = summariseTurnover([row({ sku: 5, grade: 'GRADES_CRITICAL' })]);

        expect(summary.deficit.map((entry) => entry.sku)).toEqual([5]);
    });

    it('orders the deficit by days of cover, unknown last', () => {
        const summary = summariseTurnover([
            row({ sku: 1, grade: 'DEFICIT', idc: null }),
            row({ sku: 2, grade: 'DEFICIT', idc: 6 }),
            row({ sku: 3, grade: 'DEFICIT', idc: 2 })
        ]);

        expect(summary.deficit.map((entry) => entry.sku)).toEqual([3, 2, 1]);
    });

    it('indexes by SKU for joining', () => {
        const summary = summariseTurnover([row({ sku: 42 })]);

        expect(summary.bySku.get(42)?.sku).toBe(42);
        expect(summary.bySku.get(7)).toBeUndefined();
    });

    it('is empty-safe', () => {
        const summary = summariseTurnover([]);

        expect(summary.deficit).toEqual([]);
        expect(summary.noSales).toEqual([]);
        expect(summary.graded).toBe(0);
    });
});
