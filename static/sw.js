// Service worker for the Ozon dashboard PWA.
//
// Strategy:
//   - navigations  -> network-first (fresh HTML), fall back to cache, then offline page
//   - static files -> stale-while-revalidate
//   - /api/* and any request with a query string (SvelteKit data fetches) are left
//     to the network so cached data never goes stale.

const VERSION = "v1";
const STATIC_CACHE = `ozon-static-${VERSION}`;
const PAGE_CACHE = `ozon-pages-${VERSION}`;

const PRECACHE_URLS = [
	"/offline.html",
	"/manifest.webmanifest",
	"/favicon.svg",
	"/icons/icon-192.png",
	"/icons/icon-512.png",
	"/icons/maskable-192.png",
	"/icons/maskable-512.png",
	"/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(STATIC_CACHE)
			.then((cache) => cache.addAll(PRECACHE_URLS))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((key) => key !== STATIC_CACHE && key !== PAGE_CACHE)
					.map((key) => caches.delete(key)),
			);
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;

	if (request.method !== "GET") return;

	const url = new URL(request.url);

	// Leave cross-origin requests (fonts, analytics) and the API alone.
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/")) return;

	// SvelteKit fetches route data with a query string; never serve those stale.
	if (url.search) return;

	if (request.mode === "navigate") {
		event.respondWith(networkFirst(request));
		return;
	}

	event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
	const cache = await caches.open(PAGE_CACHE);
	try {
		const response = await fetch(request);
		if (response && response.ok) {
			cache.put(request, response.clone());
		}
		return response;
	} catch (error) {
		const cached = await cache.match(request);
		if (cached) return cached;
		const offline = await caches.match("/offline.html");
		if (offline) return offline;
		throw error;
	}
}

async function staleWhileRevalidate(request) {
	const cache = await caches.open(STATIC_CACHE);
	const cached = await cache.match(request);

	const network = fetch(request)
		.then((response) => {
			if (response && response.ok && response.type === "basic") {
				cache.put(request, response.clone());
			}
			return response;
		})
		.catch(() => undefined);

	if (cached) return cached;

	const response = await network;
	return response || Response.error();
}
