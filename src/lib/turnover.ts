/**
 * Ozon's own turnover report (`/v1/analytics/turnover/stocks`).
 *
 * This is the one free analytics method worth having: Ozon computes days of cover from
 * its own demand model, per SKU and per cluster, which is better informed than the
 * dashboard's own `postings ÷ stock` estimate.
 *
 * Two constraints shape everything here:
 *
 *   1. **One request per minute** on Ozon's side, and the method paginates. A page walk
 *      would therefore take minutes, so exactly one page is requested and any truncation
 *      is reported rather than hidden.
 *   2. Published field names **disagree**. One source documents `turnover_grade` with
 *      `DEFICIT` / `OPTIMAL` / `NO_SALES`; another documents `idc_grade` with
 *      `GRADES_CRITICAL` / `GRADES_RED` / `GRADES_YELLOW` / `GRADES_GREEN`. So the
 *      parser accepts either, passes the raw string through untouched, and translates
 *      only the values it actually recognises. An unknown grade is shown as it arrived
 *      instead of being mapped onto a guess.
 */

export interface TurnoverRow {
    sku: number;
    /** Units on hand according to Ozon. */
    stock: number | null;
    /** Average daily sales. */
    ads: number | null;
    /** Inventory days of cover. */
    idc: number | null;
    /** Raw grade, exactly as Ozon sent it. */
    grade: string | null;
    /** Raw cluster-level grade, exactly as Ozon sent it. */
    gradeCluster: string | null;
}

/** Russian wording for the grade values seen in the documentation. */
const GRADE_LABELS: Record<string, string> = {
    DEFICIT: 'Дефицит',
    DEFICIT_GROWING: 'Дефицит растёт',
    DEFICIT_FALLING: 'Дефицит снижается',
    OPTIMAL: 'Оптимально',
    OPTIMAL_GROWING: 'Оптимально, растёт',
    OPTIMAL_FALLING: 'Оптимально, снижается',
    NO_SALES: 'Нет продаж',
    GRADES_CRITICAL: 'Критично',
    GRADES_RED: 'Мало',
    GRADES_YELLOW: 'Средне',
    GRADES_GREEN: 'Хорошо',
    SURPLUS: 'Избыток',
    SURPLUS_GROWING: 'Избыток растёт',
    SURPLUS_FALLING: 'Избыток снижается'
};

/**
 * A readable label for a grade.
 *
 * `null` when there is no grade at all; the raw value when it is one we do not know, so
 * a new Ozon enum never turns into a silent blank.
 */
export function gradeLabel(grade: string | null): string | null {
    if (!grade) return null;
    return GRADE_LABELS[grade] ?? grade;
}

function readNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        const parsed = Number(value.replace(/\s|\u00a0/g, '').replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function readString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    return null;
}

/** Accepts either documented envelope: `items` at the top level or under `result`. */
function itemsOf(raw: unknown): unknown[] {
    if (!raw || typeof raw !== 'object') return [];

    const record = raw as { items?: unknown; result?: { items?: unknown } };
    const items = record.items ?? record.result?.items;

    return Array.isArray(items) ? items : [];
}

/**
 * Normalises the response.
 *
 * A row without a SKU is dropped: it cannot be joined to anything. Rows missing only the
 * numbers are kept, because the grade alone is still actionable.
 */
export function toTurnoverRows(raw: unknown): TurnoverRow[] {
    const rows: TurnoverRow[] = [];

    for (const item of itemsOf(raw)) {
        if (!item || typeof item !== 'object') continue;

        const record = item as Record<string, unknown>;
        const sku = readNumber(record.sku ?? record.sku_id);
        if (sku === null) continue;

        rows.push({
            sku,
            stock: readNumber(record.current_stock ?? record.stock ?? record.present),
            ads: readNumber(record.ads ?? record.average_daily_sales),
            idc: readNumber(record.idc ?? record.days_of_cover),
            grade: readString(record.turnover_grade ?? record.idc_grade ?? record.grade),
            gradeCluster: readString(record.turnover_grade_cluster ?? record.idc_grade_cluster)
        });
    }

    return rows;
}

/** True when the response says more rows exist than were returned. */
export function isTruncated(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;

    const record = raw as { total?: unknown; total_items?: unknown; has_next?: unknown };
    const total = readNumber(record.total ?? record.total_items);
    const returned = itemsOf(raw).length;

    if (typeof total === 'number' && total > returned) return true;
    return record.has_next === true;
}

export interface TurnoverSummary {
    /** Rows Ozon grades as needing attention, most urgent first. */
    deficit: TurnoverRow[];
    /** Rows with no sales at all. */
    noSales: TurnoverRow[];
    /** Everything returned, keyed by SKU for joining. */
    bySku: Map<number, TurnoverRow>;
    /** How many rows carried a grade at all. */
    graded: number;
}

export function summariseTurnover(rows: TurnoverRow[]): TurnoverSummary {
    const bySku = new Map(rows.map((row) => [row.sku, row]));

    const rank = (grade: string | null) => {
        if (!grade) return 3;
        if (/DEFICIT|CRITICAL|RED/.test(grade)) return 0;
        if (/NO_SALES/.test(grade)) return 1;
        return 2;
    };

    const deficit = rows
        .filter((row) => rank(row.grade) === 0)
        .sort((a, b) => (a.idc ?? Number.MAX_SAFE_INTEGER) - (b.idc ?? Number.MAX_SAFE_INTEGER));

    return {
        deficit,
        noSales: rows.filter((row) => rank(row.grade) === 1),
        bySku,
        graded: rows.filter((row) => row.grade !== null).length
    };
}
