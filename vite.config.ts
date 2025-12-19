import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
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
