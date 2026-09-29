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
            { actions: ['Обработка отправления'] },
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

    it('drops the heavy financial_data.products and flattens its actions', () => {
        const posting = toDashboardPosting(rawPosting);

        expect(posting.financial_data).toEqual({
            cluster_from: 'Ярославль',
            cluster_to: 'Москва'
        });
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

    it('keys product pictures by id', () => {
        const map = buildProductImageMap([
            { product_id: 10, primary_photo: ['p.jpg'], photo: ['x.jpg'] },
            { product_id: 11, photo: ['fallback.jpg'] },
            { product_id: 12 }
        ]);

        expect(map).toEqual({ 10: 'p.jpg', 11: 'fallback.jpg', 12: '' });
    });
});
