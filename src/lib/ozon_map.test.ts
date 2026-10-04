import { describe, expect, it } from 'vitest';
import {
    buildProductImageMap,
    buildSkuImageMap,
    toDashboardPosting,
    toStockRow
} from './ozon_map';
import type { OzonPosting, OzonStockItem } from './ozon_types';

const rawPosting: OzonPosting = {
    posting_number: '1234-0001-1',
    order_number: '1234-0001',
    status: 'delivered',
    created_at: '2026-09-16T09:00:00Z',
    products: [
        {
            offer_id: 'offer-1',
            name: 'Товар',
            sku: 42,
            quantity: 2,
            price: { amount: '1699', currency: 'RUB' }
        }
    ],
    analytics_data: { city: 'Москва', payment_type_group_name: 'Ozon Банк' },
    financial_data: {
        cluster_from: 'Ярославль',
        cluster_to: 'Москва',
        products: [
            {
                product_id: 42,
                payout: 1400.5,
                // The live shape, confirmed against a real account: an object, negative amount.
                commission: { amount: -298.5, percent: 17.6, currency: 'RUB' },
                price: 1699,
                old_price: 2199,
                total_discount_value: 500,
                total_discount_percent: 22.7,
                currency_code: 'RUB',
                actions: ['Обработка отправления']
            },
            { actions: ['Сборка заказа', 'Обработка отправления'] }
        ]
    }
};

describe('toDashboardPosting', () => {
    it('keeps the fields the table renders', () => {
        const posting = toDashboardPosting(rawPosting);

        expect(posting.posting_number).toBe('1234-0001-1');
        expect(posting.status).toBe('delivered');
        expect(posting.created_at).toBe('2026-09-16T09:00:00Z');
        expect(posting.products).toEqual([
            {
                offer_id: 'offer-1',
                name: 'Товар',
                sku: 42,
                quantity: 2,
                price: { amount: '1699', currency: 'RUB' }
            }
        ]);
        expect(posting.analytics_data).toEqual({
            payment_type_group_name: 'Ozon Банк',
            city: 'Москва'
        });
    });

    it('keeps the money fields and flattens the actions', () => {
        const posting = toDashboardPosting(rawPosting);

        expect(posting.financial_data).toEqual({
            cluster_from: 'Ярославль',
            cluster_to: 'Москва'
        });
        // Payout and commission are the seller's actual money; dropping them here
        // was what made the dashboard show revenue instead of earnings.
        expect(posting.financial_products).toEqual([
            {
                product_id: 42,
                payout: 1400.5,
                commission: { amount: -298.5, percent: 17.6, currency: 'RUB' },
                commission_amount: undefined,
                commission_percent: undefined,
                price: 1699,
                old_price: 2199,
                total_discount_value: 500,
                total_discount_percent: 22.7,
                currency_code: 'RUB',
                actions: ['Обработка отправления']
            },
            {
                product_id: undefined,
                payout: undefined,
                commission: undefined,
                commission_amount: undefined,
                commission_percent: undefined,
                price: undefined,
                old_price: undefined,
                total_discount_value: undefined,
                total_discount_percent: undefined,
                currency_code: undefined,
                actions: ['Сборка заказа', 'Обработка отправления']
            }
        ]);
        expect(posting.actions).toEqual(['Обработка отправления', 'Сборка заказа']);
    });

    it('copes with missing optional blocks', () => {
        const posting = toDashboardPosting({
            posting_number: '1-1',
            status: 'cancelled',
            created_at: '2026-09-16T09:00:00Z',
            products: []
        });

        expect(posting.analytics_data).toBeUndefined();
        expect(posting.financial_data).toBeUndefined();
        expect(posting.financial_products).toEqual([]);
        expect(posting.actions).toEqual([]);
        expect(posting.products).toEqual([]);
    });
});

describe('toStockRow', () => {
    it('keeps only the rendered stock fields', () => {
        const item: OzonStockItem = {
            product_id: 1713876241,
            offer_id: 'bagpendantbrown',
            stocks: [
                {
                    type: 'fbo',
                    present: 55,
                    reserved: 1,
                    sku: 2095433653,
                    shipment_type: 'SHIPMENT_TYPE_GENERAL',
                    warehouse_ids: []
                }
            ]
        };

        expect(toStockRow(item)).toEqual({
            product_id: 1713876241,
            offer_id: 'bagpendantbrown',
            stocks: [{ type: 'fbo', present: 55, reserved: 1, sku: 2095433653 }]
        });
    });
});

describe('image maps', () => {
    it('prefers primary_image and falls back to images', () => {
        const map = buildSkuImageMap([
            { sku: 1, primary_image: 'primary.jpg', images: ['other.jpg'] },
            { sku: 2, images: ['fallback.jpg'] },
            { sku: 3 }
        ]);

        expect(map).toEqual({ 1: 'primary.jpg', 2: 'fallback.jpg', 3: '' });
    });

    it('reads the live array shape of primary_image', () => {
        const map = buildSkuImageMap([
            { sku: 1, primary_image: ['live.jpg'], images: ['other.jpg'] },
            // An empty list is what the live method sends when there is no picture at all.
            { sku: 2, primary_image: [], images: ['fallback.jpg'] },
            { sku: 3, primary_image: [] }
        ]);

        expect(map).toEqual({ 1: 'live.jpg', 2: 'fallback.jpg', 3: '' });
    });

    it('pins the per-region CDN mirror to the canonical host', () => {
        // Measured: a Russian address gets ir.ozone.ru, the deployment's region gets
        // ir-20.ozone.ru — a host whose address times out, which is what broke every picture
        // on the deployed site while the same code worked in development.
        const map = buildSkuImageMap([
            { sku: 1, primary_image: ['https://ir-20.ozone.ru/s3/multimedia-1-c/9297326964.jpg'] },
            { sku: 2, primary_image: ['https://ir.ozone.ru/s3/multimedia-1-c/7524750548.jpg'] },
            // Anything that is not an Ozon mirror is left exactly as it came.
            { sku: 3, primary_image: ['https://cdn.example.com/a.jpg'] }
        ]);

        expect(map).toEqual({
            1: 'https://ir.ozone.ru/s3/multimedia-1-c/9297326964.jpg',
            2: 'https://ir.ozone.ru/s3/multimedia-1-c/7524750548.jpg',
            3: 'https://cdn.example.com/a.jpg'
        });
    });

    it('keys product pictures by id', () => {
        const map = buildProductImageMap([
            { product_id: 10, primary_photo: ['p.jpg'], photo: ['x.jpg'] },
            { product_id: 11, photo: ['fallback.jpg'] },
            { product_id: 12 }
        ]);

        expect(map).toEqual({ 10: 'p.jpg', 11: 'fallback.jpg', 12: '' });
    });

    it('pins the mirror on the inventory map too', () => {
        const map = buildProductImageMap([
            { product_id: 10, primary_photo: ['https://ir-3.ozone.ru/s3/x.jpg'] },
            { product_id: 11, photo: ['https://ir-20.ozone.ru/s3/y.jpg'] }
        ]);

        expect(map).toEqual({
            10: 'https://ir.ozone.ru/s3/x.jpg',
            11: 'https://ir.ozone.ru/s3/y.jpg'
        });
    });
});
