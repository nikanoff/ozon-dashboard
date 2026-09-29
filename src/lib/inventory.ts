import type { OzonPosting, StockRow } from './ozon_types';
import { productUnitPrice } from './stats';

/**
 * Tier-3 insight: joins the orders the dashboard loads with the stock rows the
 * inventory endpoint loads, and turns them into replenishment signals (stock
 * runway, out-of-stock, overstock). All of it is computed in the browser from two
 * payloads the app already fetches; no extra Ozon call is involved.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Default demand window; long enough to smooth out a quiet day. */
export const DEMAND_WINDOW_DAYS = 14;

const CRITICAL_DAYS = 7;
const LOW_DAYS = 14;
const OVERSTOCK_DAYS = 60;

export type StockHealth = 'out' | 'critical' | 'low' | 'ok' | 'overstock' | 'dead';

export const STOCK_HEALTH_LABELS: Record<StockHealth, string> = {
    out: 'Нет в наличии',
    critical: 'Критично',
    low: 'Заканчивается',
    ok: 'В норме',
    overstock: 'Избыток',
    dead: 'Без продаж'
};

export interface InventoryRow {
    sku: number;
    name: string;
    offerId: string;
    /** FBO stock (the type the dashboard cares about). */
    present: number;
    reserved: number;
    /** Stock across every type, used for the runway. */
    total: number;
    /** Average units sold per day over the demand window. */
    demandPerDay: number;
    /** Days the current stock lasts at the current demand; `null` without demand. */
    daysOfCover: number | null;
    /** Revenue over the demand window. */
    revenue: number;
    /** Last known unit price, used to value the stock. */
    unitPrice: number;
    health: StockHealth;
}

export interface InventoryInsights {
    /** Every SKU seen in either payload, busiest first. */
    rows: InventoryRow[];
    /** Demand but no stock. */
    outOfStock: InventoryRow[];
    /** Fewer than 7 days of cover. */
    critical: InventoryRow[];
    /** Fewer than 14 days of cover. */
    low: InventoryRow[];
    /** More than 60 days of cover. */
    overstock: InventoryRow[];
    /** Stock sitting with no sales in the window. */
    dead: InventoryRow[];
    /** `Σ present × unitPrice`, a rough value of the FBO stock on hand. */
    inventoryValue: number;
    totalPresent: number;
    totalReserved: number;
}

interface DemandEntry {
    units: number;
    revenue: number;
    name: string;
    unitPrice: number;
}

function healthOf(
    total: number,
    demandPerDay: number,
    daysOfCover: number | null
): StockHealth {
    if (demandPerDay > 0 && total <= 0) return 'out';
    if (demandPerDay > 0 && daysOfCover !== null && daysOfCover < CRITICAL_DAYS) {
        return 'critical';
    }
    if (demandPerDay > 0 && daysOfCover !== null && daysOfCover < LOW_DAYS) return 'low';
    if (demandPerDay === 0 && total > 0) return 'dead';
    if (daysOfCover !== null && daysOfCover > OVERSTOCK_DAYS) return 'overstock';
    return 'ok';
}

/**
 * Builds the replenishment picture.
 *
 * `now` and `lookbackDays` are injectable to keep the derived numbers deterministic
 * in tests.
 */
export function inventoryInsights(
    postings: OzonPosting[],
    stockRows: StockRow[],
    now = new Date(),
    lookbackDays = DEMAND_WINDOW_DAYS
): InventoryInsights {
    const since = new Date(now.getTime() - lookbackDays * DAY);

    const demand = new Map<number, DemandEntry>();
    for (const posting of postings) {
        if (posting.status === 'cancelled') continue;

        const createdAt = new Date(posting.created_at);
        if (Number.isNaN(createdAt.getTime()) || createdAt < since) continue;

        for (const product of posting.products ?? []) {
            const quantity = product.quantity || 1;
            const entry =
                demand.get(product.sku) ??
                ({
                    units: 0,
                    revenue: 0,
                    name: product.name || product.offer_id,
                    unitPrice: 0
                } satisfies DemandEntry);

            entry.units += quantity;
            entry.revenue += productUnitPrice(product) * quantity;
            entry.unitPrice = productUnitPrice(product) || entry.unitPrice;
            if (!entry.name && (product.name || product.offer_id)) {
                entry.name = product.name || product.offer_id;
            }

            demand.set(product.sku, entry);
        }
    }

    const stock = new Map<
        number,
        { present: number; reserved: number; total: number; offerId: string }
    >();
    for (const row of stockRows) {
        for (const entry of row.stocks ?? []) {
            const aggregate =
                stock.get(entry.sku) ??
                ({ present: 0, reserved: 0, total: 0, offerId: row.offer_id });

            aggregate.total += entry.present || 0;
            aggregate.reserved += entry.reserved || 0;
            if (entry.type === 'fbo') aggregate.present += entry.present || 0;

            stock.set(entry.sku, aggregate);
        }
    }

    const rows: InventoryRow[] = [];
    for (const sku of new Set<number>([...demand.keys(), ...stock.keys()])) {
        const demandEntry = demand.get(sku);
        const stockEntry = stock.get(sku);

        const present = stockEntry?.present ?? 0;
        const reserved = stockEntry?.reserved ?? 0;
        const total = stockEntry?.total ?? 0;
        const demandPerDay = demandEntry ? demandEntry.units / lookbackDays : 0;
        const daysOfCover = demandPerDay > 0 ? total / demandPerDay : null;

        rows.push({
            sku,
            name: demandEntry?.name || stockEntry?.offerId || String(sku),
            offerId: stockEntry?.offerId || '',
            present,
            reserved,
            total,
            demandPerDay,
            daysOfCover,
            revenue: demandEntry?.revenue ?? 0,
            unitPrice: demandEntry?.unitPrice ?? 0,
            health: healthOf(total, demandPerDay, daysOfCover)
        });
    }

    rows.sort((a, b) => b.demandPerDay - a.demandPerDay || b.revenue - a.revenue);

    const inventoryValue = rows.reduce(
        (sum, row) => sum + row.total * row.unitPrice,
        0
    );

    return {
        rows,
        outOfStock: rows.filter((row) => row.health === 'out'),
        critical: rows.filter((row) => row.health === 'critical'),
        low: rows.filter((row) => row.health === 'low'),
        overstock: rows.filter((row) => row.health === 'overstock'),
        dead: rows.filter((row) => row.health === 'dead'),
        inventoryValue,
        totalPresent: rows.reduce((sum, row) => sum + row.present, 0),
        totalReserved: rows.reduce((sum, row) => sum + row.reserved, 0)
    };
}
