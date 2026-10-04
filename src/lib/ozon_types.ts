/**
 * Response types for the Ozon Seller API methods this app uses.
 *
 * The shapes come from live responses, not from the documentation: the list
 * methods return `items` at the top level (there is no `result` envelope), and
 * `v3/posting/fbo/list` nests the rows under `postings`. Only the fields the app
 * actually reads are declared; the API returns many more.
 */

export interface OzonPrice {
    amount: string;
    currency: string;
}

export interface OzonStockEntry {
    /** 'fbo' | 'fbs' | ... */
    type: string;
    present: number;
    reserved: number;
    sku: number;
    shipment_type: string;
    warehouse_ids: string[];
}

export interface OzonStockItem {
    product_id: number;
    offer_id: string;
    stocks: OzonStockEntry[];
}

export interface OzonStocksResponse {
    items: OzonStockItem[];
    total?: number;
    total_items?: number;
    /** Present while more rows are available. */
    cursor?: string;
}

export interface OzonPostingProduct {
    offer_id: string;
    name?: string;
    sku: number;
    quantity: number;
    /** v3 returns an object; the withdrawn v2 method returned a plain string. */
    price?: OzonPrice | string;
}

/**
 * One row of `financial_data.products[]`.
 *
 * This is the only place the free tier exposes money the seller actually keeps, so unit
 * economics needs no paid method. Two details were confirmed against a live account and
 * both differ from the documentation:
 *
 *   - `commission` is an **object** (`{ amount, percent, currency }`), not the flat
 *     `commission_amount` / `commission_percent` pair the docs show, and its `amount`
 *     arrives **negative**;
 *   - `payout` equals `price - |commission|`: it does **not** include logistics, handling
 *     or acquiring. Those are charged later, in the accruals. Presenting `payout` as the
 *     amount transferred to the account overstates the money by the logistics cost —
 *     verified on a live order where the accrual came to 102.53 ₽ less.
 *
 * The flat fields are kept as a fallback so both shapes parse.
 *
 * Known defect: `quantity` here is unreliable — some FBO postings omit it or send
 * `"0\""`. Always take the quantity from the top-level `products[]` instead.
 */
export interface OzonFinancialProduct {
    /** Matches `products[].sku` in the documented example, but not guaranteed to. */
    product_id?: number;
    /** What the seller keeps for this line, before logistics and acquiring. */
    payout?: number;
    /** Commission Ozon keeps, as an object whose `amount` is negative. */
    commission?: { amount?: number; percent?: number; currency?: string };
    /** Fallback shape: commission as a plain amount. */
    commission_amount?: number;
    /** Fallback shape: commission rate, in percent. */
    commission_percent?: number;
    /** Line price and the price before discount. */
    price?: number;
    old_price?: number;
    /** How much of the price was given away by discounts. */
    total_discount_value?: number;
    total_discount_percent?: number;
    currency_code?: string;
    actions?: string[];
}

export interface OzonPosting {
    posting_number: string;
    order_number?: string;
    status: string;
    created_at: string;
    /** FBO postings always carry the product list (possibly empty). */
    products: OzonPostingProduct[];
    /** Only present when the request asked for it via `with.analytics_data`. */
    analytics_data?: {
        payment_type_group_name?: string;
        city?: string;
    };
    financial_data?: {
        cluster_from?: string;
        cluster_to?: string;
        products?: OzonFinancialProduct[];
    };
}

export interface OzonPostingsResponse {
    postings: OzonPosting[];
    has_next?: boolean;
    cursor?: string;
}

export interface OzonProductInfo {
    id?: number;
    sku: number;
    name?: string;
    offer_id?: string;
    /**
     * Live responses return an **array** of URLs here; the documentation shows a string.
     *
     * Both shapes are accepted and reduced to a single URL by `buildSkuImageMap`. The deployed
     * function also receives a per-region CDN mirror in this field — `ir-20.ozone.ru` from
     * Frankfurt against `ir.ozone.ru` from a Russian address — which does not answer, so the
     * host is pinned to the canonical one there.
     */
    primary_image?: string | string[];
    images?: string[];
}

export interface OzonProductInfoListResponse {
    items: OzonProductInfo[];
}

export interface OzonProductPicture {
    product_id?: number;
    primary_photo?: string[];
    photo?: string[];
    color_photo?: string[];
}

export interface OzonPicturesResponse {
    items: OzonProductPicture[];
}

// ---------------------------------------------------------------------------
// Wire shapes: what the server endpoints send to the browser.
//
// The raw Ozon responses are far too heavy for the client (legal_info, barcodes,
// commissions, price indexes and so on), so the server keeps only the fields the
// tables actually render.
// ---------------------------------------------------------------------------

/** A posting reduced to what the orders table shows. */
export interface DashboardPosting {
    posting_number: string;
    order_number?: string;
    created_at: string;
    status: string;
    products: OzonPostingProduct[];
    analytics_data?: {
        payment_type_group_name?: string;
        city?: string;
    };
    financial_data?: {
        cluster_from?: string;
        cluster_to?: string;
    };
    /**
     * `financial_data.products[]`, kept in its own array rather than merged into
     * `products[]`.
     *
     * The two arrays describe the same lines but key them differently — the posting
     * carries `sku`, the financial row carries `product_id` — and the financial one
     * has a known gap in `quantity`. Merging them on the server would bake a guess
     * into the wire format, so the join happens in `$lib/economics.ts`, where it is
     * explicit and covered by tests.
     */
    financial_products: OzonFinancialProduct[];
    /** Flattened, de-duplicated `financial_data.products[].actions`. */
    actions: string[];
}

/** A stock row reduced to what the inventory table shows. */
export interface StockRow {
    product_id: number;
    offer_id: string;
    stocks: {
        type: string;
        present: number;
        reserved: number;
        sku: number;
    }[];
}

/**
 * One return, reduced to what the dashboard's period cards read.
 *
 * `date` is `logistic.return_date` — the moment the return was registered, which is also
 * the field `/v1/returns/list` filters on. The method ignores `since`/`to` entirely and
 * answers with the same first page whatever they say, so the filter must be spelled as
 * `logistic_return_date.{time_from,time_to}`; the identifier is kept because that is the
 * only thing `last_id` paging can follow.
 *
 * `amount` is the sale price of the returned units, not what Ozon refunded: the refund
 * itself appears in the accruals as a reversed accrual, while this figure is what the
 * line was worth when it sold.
 */
export interface OzonReturn {
    id: number;
    /** Local calendar day of `logistic.return_date`. */
    date: string;
    sku: number;
    offerId: string;
    units: number;
    amount: number;
    /** Ozon's own `type`: `Cancellation` (не забрал заказ) or `ClientReturn`. */
    type: string;
}

export interface DashboardPayload {
    postings: DashboardPosting[];
    skuToImage: Record<number, string>;
    /** When the server assembled this payload; decides full vs partial refresh. */
    fetchedAt: string;
    /** Postings older than this fall outside the dashboard's widest period. */
    oldestAllowed: string;
    /**
     * Returns for the period cards, and the window they were collected for.
     *
     * Kept apart from the postings: returns are asked for by their own date field and only
     * the cards read them, so the window is stated rather than inferred from `ranges`.
     */
    returns?: OzonReturn[];
    returnsWindow?: { from: string; to: string };
    /**
     * The ranges this payload actually holds, as `YYYY-MM-DD` pairs, oldest first.
     *
     * Two of them when an old month is on screen: the month, and today's tail, with the
     * months between them never fetched. `oldestAllowed` cannot describe that shape — it is
     * the earliest edge, so a payload holding August 2025 beside September 2026 reports
     * August 2025 and looks as though it covers everything after it. Deciding whether a
     * refresh can be merged needs the ranges themselves, which is why they are here.
     */
    ranges?: Array<{ from: string; to: string }>;
}

export interface StocksPayload {
    items: StockRow[];
    imagesMap: Record<string, string>;
}

