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
    const products = posting.financial_data?.products ?? [];

    return {
        posting_number: posting.posting_number,
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
        actions: [
            ...new Set(products.flatMap((product) => product.actions ?? []))
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

/** SKU -> primary image URL, used by the orders table. */
export function buildSkuImageMap(items: OzonProductInfo[]): Record<number, string> {
    const map: Record<number, string> = {};

    for (const item of items) {
        if (item.sku) {
            map[item.sku] = item.primary_image || item.images?.[0] || '';
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
                item.primary_photo?.[0] || item.photo?.[0] || '';
        }
    }

    return map;
}
