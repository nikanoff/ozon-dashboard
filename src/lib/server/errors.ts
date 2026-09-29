import { json } from '@sveltejs/kit';
import { OzonRequestError } from './ozon';

/** Maps upstream failures onto the response the browser sees. */
export function ozonErrorResponse(error: unknown, label: string) {
    if (error instanceof OzonRequestError) {
        return json(
            { code: error.status, message: error.message },
            { status: error.status }
        );
    }

    if ((error as Error)?.name === 'AbortError') {
        return json({ message: 'Request aborted' }, { status: 499 });
    }

    console.error(`[api/${label}] failed:`, error);
    return json({ message: 'Failed to reach Ozon API' }, { status: 502 });
}
