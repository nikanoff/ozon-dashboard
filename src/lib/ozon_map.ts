import type {
    DashboardPosting,
    OzonPosting,
    OzonProductInfo,
    OzonProductPicture,
    OzonStockItem,
    StockRow
} from './ozon_types';

/**
 * Server-side projections that strip raw Ozon responses down to what the UI
 * renders. They live here (not in `$lib/server`) so they stay unit-testable.
 */

/** Remaining fields of a posting that never reach the browser. */
export function toDashboardPosting(posting: OzonPosting): DashboardPosting {
    const financialProducts = posting.financial_data?.products ?? [];

    return {
        posting_number: posting.posting_number,
        order_number: posting.order_number,
        created_at: posting.created_at,
        status: posting.status,
        products: (posting.products ?? []).map((product) => ({
            offer_id: product.offer_id,
            name: product.name,
            sku: product.sku,
            quantity: product.quantity,
            price: product.price
        })),
        analytics_data: posting.analytics_data
            ? {
                  payment_type_group_name: posting.analytics_data.payment_type_group_name,
                  city: posting.analytics_data.city
              }
            : undefined,
        financial_data: posting.financial_data
            ? {
                  cluster_from: posting.financial_data.cluster_from,
                  cluster_to: posting.financial_data.cluster_to
              }
            : undefined,
        // Kept whole: payout and commission are the seller's actual money, and they
        // are the only such figures the free tier exposes.
        financial_products: financialProducts.map((row) => ({
            product_id: row.product_id,
            payout: row.payout,
            // The live shape: an object whose `amount` is negative. Passing only the flat
            // `commission_amount` fields here silently dropped the real commission, which
            // left the dashboard reporting a zero commission on real orders.
            commission: row.commission,
            commission_amount: row.commission_amount,
            commission_percent: row.commission_percent,
            price: row.price,
            old_price: row.old_price,
            total_discount_value: row.total_discount_value,
            total_discount_percent: row.total_discount_percent,
            currency_code: row.currency_code,
            actions: row.actions
        })),
        actions: [
            ...new Set(financialProducts.flatMap((product) => product.actions ?? []))
        ]
    };
}

export function toStockRow(item: OzonStockItem): StockRow {
    return {
        product_id: item.product_id,
        offer_id: item.offer_id,
        stocks: (item.stocks ?? []).map((stock) => ({
            type: stock.type,
            present: stock.present,
            reserved: stock.reserved,
            sku: stock.sku
        }))
    };
}

/**
 * Ozon answers with one of several CDN mirrors, chosen by where the request came from.
 *
 * Verified against the live account: the same call returned `ir.ozone.ru` from a Russian
 * address and `ir-20.ozone.ru` from the region the deployment runs in — and that host does not
 * answer at all (its address times out; `ir-1` does not even resolve). So every product picture
 * on the deployed site was a broken image while the identical code served working ones in
 * development, which is a difference no amount of reading the front end would explain.
 *
 * The mirrors are the same CDN, so the host is pinned to the canonical one. That also makes the
 * payload stable: the same product yields the same URL wherever the function happens to run.
 */
export function canonicalImageUrl(value: unknown): string {
    const url = firstUrl(value);
    if (!url) return '';

    return url.replace(/^https?:\/\/ir-\d+\.ozone\.ru\//, 'https://ir.ozone.ru/');
}

/**
 * The first usable URL in a value that may be a string or a list of them.
 *
 * The live shape of `primary_image` is an **array**; the documentation shows a string. Taking
 * the value as-is put an array into the payload, where it only worked because a one-element
 * array stringifies to its element — a coincidence, not a contract.
 */
function firstUrl(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (!Array.isArray(value)) return '';

    const first = value.find((entry) => typeof entry === 'string' && entry.trim() !== '');
    return typeof first === 'string' ? first.trim() : '';
}

/** SKU -> primary image URL, used by the orders table. */
export function buildSkuImageMap(items: OzonProductInfo[]): Record<number, string> {
    const map: Record<number, string> = {};

    for (const item of items) {
        if (item.sku) {
            map[item.sku] = canonicalImageUrl(item.primary_image) || canonicalImageUrl(item.images);
        }
    }

    return map;
}

/** Product id -> primary photo URL, used by the inventory table. */
export function buildProductImageMap(
    items: OzonProductPicture[]
): Record<string, string> {
    const map: Record<string, string> = {};

    for (const item of items) {
        if (item.product_id !== undefined) {
            map[String(item.product_id)] =
                canonicalImageUrl(item.primary_photo) || canonicalImageUrl(item.photo);
        }
    }

    return map;
}
