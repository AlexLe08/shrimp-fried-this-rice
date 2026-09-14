import { describe, it, expect } from 'vitest';
import { closeDatabase, getGuildSettings } from '../../src/storage.ts';

// Vitest gives each test file its own isolated instance;
// If we test the closing database alongside other tests in the same files, every __resetForTests() would start failing since its a closed connection
describe('closeDatabase', () => {
	it('closes the connection so further queries fail', () => {
		expect(() => getGuildSettings('some-guild')).not.toThrow();
		closeDatabase();
		expect(() => getGuildSettings('some-guild')).toThrow();
	});
});