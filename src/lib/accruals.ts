/**
 * Parsing and folding of financial accruals — the pure half.
 *
 * The network walk lives in `$lib/server/accruals.ts`; everything here is a plain
 * function so it can be tested without a server or an API key.
 *
 * Ozon replaced `/v3/finance/transaction/list` with `/v1/finance/accrual/by-day` on
 * 8 September 2026. The new response is shaped differently in three ways that matter:
 *
 *   - it covers a **single day** per request, so a period is walked day by day;
 *   - pagination is a **cursor** (`last_id`), not page numbers;
 *   - fees are **nested and scattered** — for a posting under
 *     `posting.products[].delivery.services`, for an item under
 *     `item_fees.fees[].fees[]`, for everything else under `non_item_fee` and
 *     `container_fees` — and carry only a `type_id`, with names in a separate catalogue.
 *
 * Because the shape is Ozon's to change, the parser searches the tree for
 * `{ type_id, accrued }` pairs at any depth instead of following a fixed path. That is
 * deliberately looser than a typed schema: it survives a level being added or renamed,
 * which has already happened more than once.
 *
 * Two rules are encoded below because getting them wrong costs real money:
 *
 *   1. `total_amount` is the truth and is never recomputed from commission and fees.
 *      Fines, insurance and compensations carry no parts at all, only an amount.
 *   2. Accruals without a `unit_number` are cabinet-level costs (storage, advertising,
 *      review collection). They are reported separately and never spread across orders,
 *      so a per-order figure keeps matching the cabinet.
 */

export type AccrualCategory = 'POSTING' | 'ITEM' | 'NON_ITEM' | 'UNKNOWN';

/** One `{ type_id, accrued }` pair found anywhere in an accrual. */
export interface AccrualFee {
    typeId: string;
    amount: number;
}

export interface Accrual {
    /** `accrual_id`, which equals the old `operation_id`. */
    id: string;
    date: string;
    category: AccrualCategory;
    /** `unit_number` — the posting for POSTING/ITEM, a document number for NON_ITEM. */
    postingNumber: string | null;
    /** `total_amount.amount`: net, and authoritative. */
    amount: number;
    /** Seller price where the response exposes it, for the revenue side of the bridge. */
    gross: number | null;
    fees: AccrualFee[];
}

/**
 * True when an accrual belongs to the cabinet rather than to an order.
 *
 * The category decides it, **not** the presence of a `unit_number`: a live account sends
 * `NON_ITEM` rows with a document number in that field (storage, click charges, cross
 * docking), so testing for a missing number would file cabinet costs under orders and make
 * per-order figures stop matching the cabinet.
 */
export function isCabinetLevel(accrual: Pick<Accrual, 'category' | 'postingNumber'>): boolean {
    return accrual.category === 'NON_ITEM' || !accrual.postingNumber;
}

/**
 * A day's accruals folded into the totals a profit-and-loss view needs.
 *
 * Aggregated rather than stored raw: 31 days of operations is thousands of nested rows,
 * while these numbers are all the bridge and the cost breakdown actually read.
 */
export interface AccrualDaySummary {
    date: string;
    /**
     * `ok` — data arrived; `empty` — Ozon reported nothing that day; `failed` — the call
     * itself broke. The third state exists because a technical gap that is mistaken for
     * "no accruals" is how a dashboard quietly reports zero profit.
     */
    status: 'ok' | 'empty' | 'failed';
    error?: string;
    /** Sum of `total_amount` over every accrual of the day. */
    net: number;
    /** Sum of the seller-price side, where present. */
    gross: number;
    /** Deductions and additions by fee type, for the P&L lines. */
    byType: Record<string, number>;
    /** Net per category: `POSTING`, `ITEM`, `NON_ITEM`. */
    byCategory: Record<string, number>;
    /** Cabinet-level costs only, kept out of the per-order figures. */
    cabinetByType: Record<string, number>;
    counts: { total: number; withPosting: number; cabinet: number };
    /**
     * Net per posting, kept only for recent days.
     *
     * Bounded on purpose: it is what lets the dashboard point at delivered orders that
     * have no accrual yet — money Ozon has not paid out — without storing every posting
     * of the whole window.
     */
    byPosting?: Record<string, number>;
}

/** How many trailing days keep their per-posting detail. */
export const POSTING_DETAIL_DAYS = 14;

/** Widest window the dashboard asks for. */
export const MAX_ACCRUAL_DAYS = 62;

/** Reads a money value that may be a number, a numeric string, or `{ amount }`. */
export function readAmount(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        const parsed = Number(value.replace(/\s|\u00a0/g, '').replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : null;
    }

    if (value && typeof value === 'object') {
        const nested =
            (value as { amount?: unknown }).amount ?? (value as { value?: unknown }).value;
        return readAmount(nested);
    }

    return null;
}

/**
 * Walks a response tree collecting every `{ type_id, accrued }` pair.
 *
 * The walk stops at a pair it recognises: descending into it would count the same fee
 * twice, because its children are descriptive fields.
 */
export function collectFees(node: unknown, out: AccrualFee[] = [], depth = 0): AccrualFee[] {
    // A malformed or deeply nested payload must not hang the request.
    if (depth > 12 || node === null || typeof node !== 'object') return out;

    if (Array.isArray(node)) {
        for (const item of node) collectFees(item, out, depth + 1);
        return out;
    }

    const record = node as Record<string, unknown>;
    const typeId = record.type_id;

    if (typeId !== undefined && typeId !== null) {
        const amount = readAmount(record.accrued);
        if (amount !== null) {
            out.push({ typeId: String(typeId), amount });
            return out;
        }
    }

    for (const value of Object.values(record)) {
        collectFees(value, out, depth + 1);
    }

    return out;
}

/** Normalises one raw accrual. Absent fields become `null`, never zero. */
export function toAccrual(raw: unknown): Accrual | null {
    if (!raw || typeof raw !== 'object') return null;

    const record = raw as Record<string, unknown>;
    const amount = readAmount(record.total_amount);
    if (amount === null) return null;

    const category = String(record.accrued_category ?? '');
    const unitNumber = record.unit_number ?? record.posting_number;
    const fees = collectFees(record);

    const gross =
        readAmount((record.posting as { seller_price?: unknown } | undefined)?.seller_price) ??
        readAmount(record.seller_price);

    return {
        id: String(record.accrual_id ?? record.operation_id ?? ''),
        date: String(record.date ?? '').slice(0, 10),
        category: ['POSTING', 'ITEM', 'NON_ITEM'].includes(category)
            ? (category as AccrualCategory)
            : 'UNKNOWN',
        postingNumber: unitNumber ? String(unitNumber) : null,
        amount,
        gross,
        fees
    };
}

function addTo(target: Record<string, number>, key: string, value: number) {
    target[key] = (target[key] ?? 0) + value;
}

/** Folds a day's accruals into the totals the dashboard draws. */
export function summariseDay(
    date: string,
    accruals: Accrual[],
    keepPostingDetail = false
): AccrualDaySummary {
    const summary: AccrualDaySummary = {
        date,
        status: accruals.length === 0 ? 'empty' : 'ok',
        net: 0,
        gross: 0,
        byType: {},
        byCategory: {},
        cabinetByType: {},
        counts: { total: accruals.length, withPosting: 0, cabinet: 0 }
    };

    if (keepPostingDetail) summary.byPosting = {};

    for (const accrual of accruals) {
        summary.net += accrual.amount;
        summary.gross += accrual.gross ?? 0;
        addTo(summary.byCategory, accrual.category, accrual.amount);

        // Fee types attribute the deductions; `total_amount` already nets them out, so
        // these are never summed into the net.
        for (const fee of accrual.fees) {
            addTo(summary.byType, fee.typeId, fee.amount);
        }

        if (accrual.postingNumber && !isCabinetLevel(accrual)) {
            summary.counts.withPosting += 1;
            if (summary.byPosting) {
                addTo(summary.byPosting, accrual.postingNumber, accrual.amount);
            }
        } else {
            // Storage, click charges, cross docking: the cabinet's own costs, kept apart so
            // a per-order figure keeps matching the cabinet.
            summary.counts.cabinet += 1;
            summary.cabinetByType.total = (summary.cabinetByType.total ?? 0) + accrual.amount;
            for (const fee of accrual.fees) {
                addTo(summary.cabinetByType, fee.typeId, fee.amount);
            }
        }
    }

    return summary;
}

/**
 * Reads the `type_id` catalogue.
 *
 * A live account returns `{ accrual_types: [{ id, name, description }] }`, where `name` is
 * an English code-like label ("Acquiring", "BackwardShipment") and **`description` is the
 * Russian wording** ("Эквайринг", "Обратная магистраль") that belongs in the interface.
 * The other envelopes are still accepted, since only one account's shape has been seen.
 */
export function toTypeCatalogue(raw: unknown): Record<string, string> {
    const response = (raw ?? {}) as {
        accrual_types?: unknown[];
        types?: unknown[];
        result?: { types?: unknown[] };
    };
    const list = response.accrual_types ?? response.types ?? response.result?.types ?? [];
    const types: Record<string, string> = {};

    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const { id, name, description } = entry as {
            id?: unknown;
            name?: unknown;
            description?: unknown;
        };
        if (id === undefined) continue;

        const label =
            (typeof description === 'string' && description) ||
            (typeof name === 'string' && name) ||
            String(id);

        types[String(id)] = label;
    }

    return types;
}
