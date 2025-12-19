import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const initialClientId = browser ? localStorage.getItem('ozon_client_id') || '' : '';
const initialApiKey = browser ? localStorage.getItem('ozon_api_key') || '' : '';

export const ozonKeys = writable({
    clientId: initialClientId,
    apiKey: initialApiKey
});

if (browser) {
    ozonKeys.subscribe(value => {
        localStorage.setItem('ozon_client_id', value.clientId);
        localStorage.setItem('ozon_api_key', value.apiKey);
    });
}
