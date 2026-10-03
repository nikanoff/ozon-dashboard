import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// Bind IPv4 explicitly. Node resolves `localhost` to `::1` first, so the default dev
	// server listens on IPv6 only — and a browser that picks IPv4 for `localhost` cannot
	// connect, which looks like the server not running. 127.0.0.1 answers both `localhost`
	// and `127.0.0.1`. Verified on this machine: with the default, 127.0.0.1:5173 refuses
	// the connection; with this, every address except the `[::1]` literal answers.
	server: {
		host: '127.0.0.1'
	},
	build: {
		cssMinify: true,
		reportCompressedSize: false,
		chunkSizeWarningLimit: 500,
		rollupOptions: {
			output: {
				manualChunks: undefined // Let SvelteKit handle chunking
			}
		}
	}
});
