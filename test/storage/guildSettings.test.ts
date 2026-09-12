import { describe, it, expect, beforeEach } from 'vitest';
import { getGuildSettings, setGuildMasterEnabled, __resetForTests } from '../../src/storage.ts';

beforeEach(() => {
	__resetForTests();
});

describe('getGuildSettings', () => {
	it('returns undefined for a guild that has never set the master toggle', () => {
		expect(getGuildSettings('guild-1')).toBeUndefined();
	});

	it('returns the row after the master toggle has been set', () => {
		setGuildMasterEnabled('guild-1', false);
		const settings = getGuildSettings('guild-1');
		expect(settings?.master_enabled).toBe(0);
	});
});

describe('setGuildMasterEnabled', () => {
	it('updates the existing row in place, rather than creating a duplicate', () => {
		setGuildMasterEnabled('guild-1', true);
		setGuildMasterEnabled('guild-1', false);
		expect(getGuildSettings('guild-1')?.master_enabled).toBe(0);
	});
});