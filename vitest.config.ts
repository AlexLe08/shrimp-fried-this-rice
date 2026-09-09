import { defineConfig } from 'vitest/config';

// 
export default defineConfig({
	test: {
        // use setUpfiles to run a script before each test file, which is useful for setting up global variables or mocking certain modules.
		setupFiles: ['./test/setup.ts'],
	},
});