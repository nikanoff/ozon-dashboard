import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { OZON_CLIENT_ID, OZON_API_KEY, OZON_BASE_URL } from '$lib/ozon_config';

export const POST: RequestHandler = async ({ request, params, url }) => {
    // Extract the path from the URL, removing the '/api/ozon' prefix
    const path = url.pathname.replace('/api/ozon', '');
    const targetUrl = `${OZON_BASE_URL}${path}`;

    const body = await request.json();

    const headerClientId = request.headers.get('X-Ozon-Client-Id');
    const headerApiKey = request.headers.get('X-Ozon-Api-Key');

    const clientId = headerClientId !== null ? headerClientId : OZON_CLIENT_ID;
    const apiKey = headerApiKey !== null ? headerApiKey : OZON_API_KEY;

    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Client-Id': clientId,
                'Api-Key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });


        const data = await response.json();

        return json(data, { status: response.status });
    } catch (error) {
        console.error('Ozon API proxy error:', error);
        return json({ error: 'Internal Server Error' }, { status: 500 });
    }
};
