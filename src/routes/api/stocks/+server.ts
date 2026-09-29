import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { collectPictures, collectStocks, readCredentials } from '$lib/server/ozon';
import { ozonErrorResponse } from '$lib/server/errors';
import { buildProductImageMap, toStockRow } from '$lib/ozon_map';

/** The inventory payload in a single request; see the dashboard endpoint. */
export const config = { maxDuration: 30 };

export const POST: RequestHandler = async ({ request }) => {
    const credentials = readCredentials(request);

    if (!credentials) {
        return json(
            { code: 16, message: 'Client-Id and Api-Key headers are required' },
            { status: 401 }
        );
    }

    const { signal } = request;

    try {
        const items = await collectStocks(credentials, signal);

        const productIds = [
            ...new Set(items.map((item) => String(item.product_id)))
        ];
        const pictures =
            productIds.length > 0 ? await collectPictures(credentials, productIds, signal) : [];

        return json({
            items: items.map(toStockRow),
            imagesMap: buildProductImageMap(pictures)
        });
    } catch (error) {
        return ozonErrorResponse(error, 'stocks');
    }
};
