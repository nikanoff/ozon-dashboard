<script lang="ts">
	import "../app.css";
	import { browser, dev } from "$app/environment";
	import { onMount } from "svelte";
	import { injectAnalytics } from "@vercel/analytics/sveltekit";
	injectAnalytics();
	let { children } = $props();

	onMount(() => {
		// The service worker caches the app shell for offline/PWA installs. Skip it
		// in dev so HMR and freshly rebuilt chunks are never served from cache.
		if (dev || !browser || !("serviceWorker" in navigator)) return;

		navigator.serviceWorker.register("/sw.js").catch(() => {
			// Installability is a progressive enhancement; ignore failures.
		});
	});
</script>

{@render children()}
