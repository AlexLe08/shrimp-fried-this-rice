import { describe, it, expect } from 'vitest';
import { closeDatabase, getGuildSettings } from '../../src/storage.ts';

// Its own file: Vitest isolates each file, and once closed, the connection
// can't be reopened for the other storage tests.
describe('closeDatabase', () => {
	it('closes the connection so further queries fail', () => {
		expect(() => getGuildSettings('some-guild')).not.toThrow();
		closeDatabase();
		expect(() => getGuildSettings('some-guild')).toThrow();
	});
});
