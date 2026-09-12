import { describe, it, expect, beforeEach } from 'vitest';
import {
	upsertUserSettings,
	getUserSettings,
	updateUserLastSent,
	getDueUserSettings,
	deleteUserSettings,
	__resetForTests,
} from '../../src/storage.ts';

// Reset the database before each test
beforeEach(() => {
	__resetForTests();
});

const ONE_MINUTE = 60_000;

// Helper function to create a user with default settings, allowing overrides for specific fields
function makeUser(overrides: Partial<Parameters<typeof upsertUserSettings>[0]> = {}) {
	upsertUserSettings({
		userId: 'user-1',
		dmEnabled: true,
		intervalMinutes: 60,
		message: 'Drink water!',
		...overrides,
	});
}

describe('upsertUserSettings', () => {
	it('creates a new row when none exists', () => {
		makeUser();

		const settings = getUserSettings('user-1');
		expect(settings).toBeDefined();
		expect(settings?.dm_enabled).toBe(1);
		expect(settings?.interval_minutes).toBe(60);
		expect(settings?.message).toBe('Drink water!');
	});
    // calling upsertUserSettings twice for the same user should silently succeed and overwrite, never throw
	it('updates the existing row in place, rather than creating a duplicate', () => {
		makeUser({ intervalMinutes: 60, message: 'first' });
		makeUser({ intervalMinutes: 30, message: 'second' });

		const settings = getUserSettings('user-1');
		expect(settings?.interval_minutes).toBe(30);
		expect(settings?.message).toBe('second');
	});

    // When upserting an existing user, the last_sent_at timestamp should not be reset to 0; it should remain whatever it was before the upsert.
	it('does not reset last_sent_at when re-upserting', () => {
		makeUser();
		const now = Date.now();
		updateUserLastSent('user-1', now);

		makeUser({ message: 'updated message only' });

		const settings = getUserSettings('user-1');
		expect(settings?.last_sent_at).toBe(now);
	});
});

describe('getUserSettings', () => {
	it('returns undefined for a user with no settings', () => {
		expect(getUserSettings('nonexistent-user')).toBeUndefined();
	});
});

describe('deleteUserSettings', () => {
	it('removes the row entirely', () => {
		makeUser();
		deleteUserSettings('user-1');
		expect(getUserSettings('user-1')).toBeUndefined();
	});

	it('does nothing if the user has no settings to begin with', () => {
		expect(() => deleteUserSettings('nonexistent-user')).not.toThrow();
	});
});

describe('getDueUserSettings', () => {
	it('excludes a user whose interval has not yet elapsed', () => {
		makeUser({ intervalMinutes: 10 });
		const now = Date.now();
		updateUserLastSent('user-1', now);

		const due = getDueUserSettings(now + 5 * ONE_MINUTE);
		expect(due).toHaveLength(0);
	});

	it('includes a user exactly at their interval boundary (inclusive)', () => {
		makeUser({ intervalMinutes: 10 });
		const sentAt = 1_000_000;
		updateUserLastSent('user-1', sentAt);

		const due = getDueUserSettings(sentAt + 10 * ONE_MINUTE);
		expect(due).toHaveLength(1);
	});

	it('excludes a user who has DMs disabled, even if their interval has elapsed', () => {
		makeUser({ dmEnabled: false, intervalMinutes: 10 });
		updateUserLastSent('user-1', 1_000_000);

		const due = getDueUserSettings(1_000_000 + 100 * ONE_MINUTE);
		expect(due).toHaveLength(0);
	});

	it('includes a brand-new opted-in user (last_sent_at = 0) immediately', () => {
		makeUser({ intervalMinutes: 1440 });

		const due = getDueUserSettings(Date.now());
		expect(due).toHaveLength(1);
	});

	it('only returns due settings for the requesting user, not other users', () => {
		makeUser({ userId: 'user-1', intervalMinutes: 10 });
		updateUserLastSent('user-1', 1_000_000);

		makeUser({ userId: 'user-2', intervalMinutes: 10 });
		updateUserLastSent('user-2', 1_000_000);

		const due = getDueUserSettings(1_000_000 + 100 * ONE_MINUTE);
		expect(due).toHaveLength(2);
		expect(due.map(u => u.user_id).sort()).toEqual(['user-1', 'user-2']);
	});
});