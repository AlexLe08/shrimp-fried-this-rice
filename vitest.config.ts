import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		setupFiles: ['./test/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/**/*.ts'],
            exclude: ['src/index.ts', 'src/deploy-commands.ts', 'src/types/**'],

		},
	},
});