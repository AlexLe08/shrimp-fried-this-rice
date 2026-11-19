import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
	// Build and test output, scratch files, and other worktrees.
	globalIgnores(['dist/', 'coverage/', '.logs/', '.claude/']),
	tseslint.configs.recommended,
	{
		// A promise nobody awaits or catches becomes an unhandled rejection, which
		// crashes the process on Node 24 (it took the bot down in production once).
		files: ['src/**/*.ts'],
		languageOptions: { parserOptions: { projectService: true } },
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
		},
	},
]);
