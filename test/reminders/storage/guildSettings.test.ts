import { describe, it, expect, beforeEach } from 'vitest';
import { getGuildSettings, isGuildMasterEnabled, setGuildMasterEnabled } from '../../../src/reminders/storage.ts';
import { __resetForTests } from '../../../src/core/database.ts';

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

describe('isGuildMasterEnabled', () => {
	it('is true for a guild that has never set the master toggle', () => {
		expect(isGuildMasterEnabled('guild-1')).toBe(true);
	});

	it('follows the master toggle once it is set', () => {
		setGuildMasterEnabled('guild-1', false);
		expect(isGuildMasterEnabled('guild-1')).toBe(false);
		setGuildMasterEnabled('guild-1', true);
		expect(isGuildMasterEnabled('guild-1')).toBe(true);
	});
});
