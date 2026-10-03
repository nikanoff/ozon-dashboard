/**
 * Unit costs, kept as a dated history rather than a single number.
 *
 * A seller's purchase price changes, and a margin for August must use the cost that
 * applied in August. Storing only the current cost silently rewrites history every
 * time it is edited, so each product carries a small list of `{ from, unitCost }`
 * points and anything valued at a date resolves against that date.
 *
 * Framework-free on purpose: the Svelte store in `stores/cogs.ts` is a thin
 * persistence wrapper, so the arithmetic stays unit-testable.
 */

/** Cost per unit effective from a local calendar day, `YYYY-MM-DD`. */
export interface CostPoint {
    from: string;
    unitCost: number;
}

/** Product key -> points, oldest first. */
export type CostBook = Record<string, CostPoint[]>;

/** How a cost was resolved for a particular date. */
export interface ResolvedCost {
    unitCost: number;
    /**
     * `false` when the date being valued is older than every recorded point, so the
     * figure is the earliest known cost carried backwards. Callers should say so
     * rather than present it as fact.
     */
    exact: boolean;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar day as `YYYY-MM-DD` (not UTC: a seller thinks in local days). */
export function isoDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Records a cost, replacing any point that already exists for that day.
 *
 * Editing "the current cost" therefore appends to the history instead of erasing it.
 */
export function setCost(
    book: CostBook,
    key: string,
    unitCost: number,
    from: string = isoDay(new Date())
): CostBook {
    if (!key || !Number.isFinite(unitCost) || unitCost < 0) return book;

    const points = (book[key] ?? []).filter((point) => point.from !== from);
    points.push({ from, unitCost });
    points.sort((a, b) => a.from.localeCompare(b.from));

    return { ...book, [key]: points };
}

/** Drops a product's whole cost history. */
export function removeCost(book: CostBook, key: string): CostBook {
    if (!(key in book)) return book;

    const next = { ...book };
    delete next[key];
    return next;
}

/** Sets many costs at once, for the current day. Used by the CSV import. */
export function mergeCosts(
    book: CostBook,
    costs: { key: string; unitCost: number }[],
    from: string = isoDay(new Date())
): CostBook {
    return costs.reduce((acc, entry) => setCost(acc, entry.key, entry.unitCost, from), book);
}

/**
 * The cost that applied on `date`.
 *
 * Picks the latest point at or before the date. When the date precedes every recorded
 * point, the earliest one is returned with `exact: false` — better than showing no
 * margin at all, as long as the caller labels it.
 */
export function costAt(
    book: CostBook,
    key: string,
    date: Date | string
): ResolvedCost | undefined {
    const points = book[key];
    if (!points || points.length === 0) return undefined;

    const day = typeof date === 'string' ? date.slice(0, 10) : isoDay(date);
    if (!DAY_PATTERN.test(day)) return undefined;

    let found: CostPoint | undefined;
    for (const point of points) {
        if (point.from <= day) found = point;
        else break;
    }

    if (found) return { unitCost: found.unitCost, exact: true };

    return { unitCost: points[0].unitCost, exact: false };
}

/** Reads a number that may use either a dot or a comma as the decimal separator. */
function parseAmount(raw: string): number | undefined {
    const cleaned = raw.replace(/\s|\u00a0/g, '').replace(',', '.');
    if (!cleaned) return undefined;

    const value = Number(cleaned);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface CostParseResult {
    costs: { key: string; unitCost: number }[];
    /** Lines that could not be read, with their number, so the UI can explain. */
    skipped: { line: number; text: string }[];
}

/**
 * Parses a cost list pasted or imported from a spreadsheet.
 *
 * Separator rule, in order: a `;` or a tab if the line has one (what a Russian-locale
 * Excel export uses), otherwise the first comma. The cost field itself may use either
 * a dot or a single comma for decimals. A header row is detected and ignored rather
 * than imported as a product called "артикул".
 */
export function parseCostList(text: string): CostParseResult {
    const costs: { key: string; unitCost: number }[] = [];
    const skipped: { line: number; text: string }[] = [];

    text.split(/\r?\n/).forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) return;

        const separator = /[;\t]/.test(line) ? /[;\t]/ : ',';
        const splitAt = line.search(separator);
        if (splitAt === -1) {
            skipped.push({ line: index + 1, text: line });
            return;
        }

        const key = line.slice(0, splitAt).trim().replace(/^"|"$/g, '');
        const rawCost = line.slice(splitAt + 1).trim().replace(/^"|"$/g, '');

        // A header row has a word where the article code belongs.
        if (/^(артикул|offer_?id|sku|ключ|название)$/i.test(key)) return;

        const unitCost = parseAmount(rawCost);
        if (!key || unitCost === undefined) {
            skipped.push({ line: index + 1, text: line });
            return;
        }

        costs.push({ key, unitCost });
    });

    return { costs, skipped };
}

/** Renders the book as a `;`-separated list, ready to paste back into a spreadsheet. */
export function toCostList(book: CostBook): string {
    return Object.entries(book)
        .map(([key, points]) => {
            const latest = points[points.length - 1];
            return latest ? `${key};${latest.unitCost}` : '';
        })
        .filter(Boolean)
        .join('\n');
}
