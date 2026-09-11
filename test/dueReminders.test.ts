import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	createGuildReminder,
	updateGuildReminderLastSent,
	getDueGuildReminders,
	setGuildMasterEnabled,
	setGuildReminderEnabled,
	__resetForTests,
} from '../src/storage.ts';

beforeEach(() => {
	__resetForTests();
});

const ONE_MINUTE = 60_000;

describe('getDueGuildReminders', () => {
	it('excludes a reminder whose interval has not yet elapsed', () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 10, message: 'hi' });
		const now = Date.now();
		updateGuildReminderLastSent(1, now); // "just sent" 10-minute reminder

		const due = getDueGuildReminders(now + 5 * ONE_MINUTE); // only 5 of 10 minutes passed
		expect(due).toHaveLength(0);
	});

	it('includes a reminder exactly at its interval boundary (inclusive)', () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 10, message: 'hi' });
		const sentAt = 1_000_000;
		updateGuildReminderLastSent(1, sentAt);

		const due = getDueGuildReminders(sentAt + 10 * ONE_MINUTE); // exactly 10 minutes later
		expect(due).toHaveLength(1);
	});

	it('excludes a reminder that is individually disabled', () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 10, message: 'hi' });
		setGuildReminderEnabled('g1', 'water', false);

		const due = getDueGuildReminders(Date.now() + 100 * ONE_MINUTE);
		expect(due).toHaveLength(0);
	});

	it("excludes a reminder when the guild's master toggle is off, even if individually enabled", () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 10, message: 'hi' });
		setGuildMasterEnabled('g1', false);

		const due = getDueGuildReminders(Date.now() + 100 * ONE_MINUTE);
		expect(due).toHaveLength(0);
	});

	it('treats a guild with no guild_settings row as master-enabled by default', () => {
		// Deliberately never call setGuildMasterEnabled; simulates a guild that's never touched the master toggle.
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 10, message: 'hi' });

		const due = getDueGuildReminders(Date.now() + 100 * ONE_MINUTE);
		expect(due).toHaveLength(1);
	});

	it('includes a brand-new reminder (last_sent_at = 0) immediately', () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 1440, message: 'hi' });

		const due = getDueGuildReminders(Date.now());
		expect(due).toHaveLength(1);
	});
});