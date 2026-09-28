import { defineConfig } from 'vitest/config';

export default defineConfig({
	// n8n loads nodes through CommonJS; its ESM build only resolves when bundled.
	resolve: { alias: { 'n8n-workflow': 'n8n-workflow/dist/cjs/index.js' } },
	test: { server: { deps: { external: [/n8n-workflow/] } } },
});
