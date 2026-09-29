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
        products?: { actions?: string[] }[];
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
    primary_image?: string;
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

export interface DashboardPayload {
    postings: DashboardPosting[];
    skuToImage: Record<number, string>;
    /** When the server assembled this payload; decides full vs partial refresh. */
    fetchedAt: string;
    /** Postings older than this fall outside the dashboard's widest period. */
    oldestAllowed: string;
}

export interface StocksPayload {
    items: StockRow[];
    imagesMap: Record<string, string>;
}
