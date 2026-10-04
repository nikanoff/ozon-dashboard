import { callOzonWithRetry, type Credentials } from './ozon';
import type { OzonReturn } from '$lib/ozon_types';

/**
 * The network half of the returns feed: walks `/v1/returns/list`.
 *
 * Two things about this method were established by reading live responses, and both differ
 * from the shape the field names suggest:
 *
 *   1. **`filter.since` / `filter.to` are ignored.** The same first page comes back for any
 *      pair of dates, so a caller that believes it filtered a day is in fact holding the
 *      oldest returns of the account. The window is `filter.logistic_return_date.time_from`
 *      and `time_to`; with those, a September request returned exactly September's 112 rows.
 *   2. **There is no cursor in the body**, only `has_next`. Paging continues by sending the
 *      identifier of the last row received as `last_id` — the field the request accepts and
 *      the response never echoes.
 *
 * `limit` is capped at 500 by the API: 1000 is answered with
 * `value must be inside range (0, 500]` rather than being clamped.
 *
 * Parsing is deliberately tolerant: a return without a readable date or product is skipped
 * rather than allowed to poison the totals with zeros.
 */

const RETURNS_PATH = '/v1/returns/list';
/** Largest page the method accepts; 1000 is rejected outright. */
const PAGE_LIMIT = 500;
/** A runaway paging guard: ten pages is 5 000 returns. */
const MAX_PAGES = 10;

interface ReturnsResponse {
    returns?: unknown[];
    has_next?: boolean;
    message?: string;
}

/** `YYYY-MM-DD` in local time, the unit the period cards count in. */
function localDay(value: Date): string {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
}

function numberOrNull(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value.replace(/\s|\u00a0/g, '').replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * One raw return as the wire record, or `null` when it cannot be counted.
 *
 * The date comes from `logistic.return_date` — the same field the filter uses, so a record
 * that arrives is inside the requested window by construction. `visual.change_moment` is a
 * fallback for returns whose logistic block is empty; a record with neither is dropped,
 * because an undated return cannot be attributed to any period.
 */
export function toReturn(raw: unknown): OzonReturn | null {
    if (!raw || typeof raw !== 'object') return null;

    const row = raw as {
        id?: unknown;
        type?: unknown;
        logistic?: { return_date?: unknown; final_moment?: unknown };
        visual?: { change_moment?: unknown };
        product?: {
            sku?: unknown;
            offer_id?: unknown;
            quantity?: unknown;
            price?: { price?: unknown };
        };
    };

    const id = numberOrNull(row.id);
    const sku = numberOrNull(row.product?.sku);
    if (id === null || sku === null) return null;

    const rawDate = row.logistic?.return_date ?? row.visual?.change_moment ?? row.logistic?.final_moment;
    const at = typeof rawDate === 'string' ? new Date(rawDate) : null;
    if (!at || Number.isNaN(at.getTime())) return null;

    const units = numberOrNull(row.product?.quantity) ?? 1;
    const unitPrice = numberOrNull(row.product?.price?.price) ?? 0;

    return {
        id,
        date: localDay(at),
        sku,
        offerId: typeof row.product?.offer_id === 'string' ? row.product.offer_id : '',
        units: units > 0 ? units : 1,
        amount: unitPrice * (units > 0 ? units : 1),
        type: typeof row.type === 'string' ? row.type : ''
    };
}

/**
 * Every return registered between two instants, oldest page first.
 *
 * `from`/`to` are instants rather than days because the filter takes them that way; the
 * caller decides the day boundaries. The window is inclusive, and a request that fails
 * propagates: a missing returns list must not read as "nothing came back this month".
 */
export async function collectReturns(
    credentials: Credentials,
    from: Date,
    to: Date,
    signal?: AbortSignal
): Promise<OzonReturn[]> {
    const rows: OzonReturn[] = [];
    let lastId = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await callOzonWithRetry<ReturnsResponse>(
            RETURNS_PATH,
            {
                filter: {
                    logistic_return_date: {
                        time_from: from.toISOString(),
                        time_to: to.toISOString()
                    }
                },
                limit: PAGE_LIMIT,
                last_id: lastId
            },
            credentials,
            signal
        );

        const batch = Array.isArray(response.returns) ? response.returns : [];
        for (const raw of batch) {
            const record = toReturn(raw);
            if (record) rows.push(record);
        }

        const next = numberOrNull((batch[batch.length - 1] as { id?: unknown } | undefined)?.id);
        // An empty page, a missing cursor or a repeated one all mean the walk is over.
        if (!response.has_next || batch.length === 0 || next === null || next === lastId) break;
        lastId = next;
    }

    return rows;
}
