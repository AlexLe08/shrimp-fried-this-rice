import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { databasePath } from '../../../src/core/database.ts';

afterEach(() => {
	vi.unstubAllEnvs();
});

// Production sets no DB_PATH: a default that drifted from the project root
// would open a new, empty database there without any error.
describe('databasePath', () => {
	it('defaults to bot.db in the project root', () => {
		vi.stubEnv('DB_PATH', undefined);
		expect(databasePath()).toBe(path.join(import.meta.dirname, '..', '..', '..', 'bot.db'));
	});

	it('uses DB_PATH when it is set', () => {
		vi.stubEnv('DB_PATH', '/somewhere/else.db');
		expect(databasePath()).toBe('/somewhere/else.db');
	});
});
