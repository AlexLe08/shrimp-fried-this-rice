import { describe, it, expect, beforeEach } from 'vitest';
import {
	createGuildReminder,
	getGuildReminderByLabel,
	updateGuildReminderLastSent,
	getDueGuildReminders,
	snoozeGuildReminder,
	unsnoozeGuildReminder,
	upsertUserSettings,
	getUserSettings,
	updateUserLastSent,
	getDueUserSettings,
	snoozeUser,
	unsnoozeUser,
} from '../../../src/reminders/storage.ts';
import { __resetForTests } from '../../../src/core/database.ts';

const ONE_MINUTE = 60_000;
const SENT_AT = 1_000_000_000;
// A 10-minute reminder last sent at SENT_AT is due from SENT_AT + 10 minutes.
const DUE_AT = SENT_AT + 10 * ONE_MINUTE;

// AUTOINCREMENT ids keep counting across __resetForTests, so look them up.
function reminderId(label: string): number {
	const reminder = getGuildReminderByLabel('g1', label);
	if (!reminder) throw new Error(`no reminder ${label}`);
	return reminder.id;
}

beforeEach(() => {
	__resetForTests();
	createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 10, message: 'hi' });
	updateGuildReminderLastSent(reminderId('water'), SENT_AT);
	upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 10, message: 'hi', embed: true });
	updateUserLastSent('u1', SENT_AT);
});

describe('guild reminder snooze', () => {
	it('starts unsnoozed', () => {
		expect(getGuildReminderByLabel('g1', 'water')?.snoozed_until).toBe(0);
	});

	it('holds back a due reminder until the snooze ends, then sends the missed one', () => {
		const until = DUE_AT + 60 * ONE_MINUTE;
		snoozeGuildReminder('g1', 'water', { until, skipMissed: false, now: DUE_AT });

		expect(getDueGuildReminders(DUE_AT)).toHaveLength(0);
		expect(getDueGuildReminders(until - 1)).toHaveLength(0);
		expect(getDueGuildReminders(until)).toHaveLength(1);
		expect(getGuildReminderByLabel('g1', 'water')?.last_sent_at).toBe(SENT_AT);
	});

	it('with skipMissed, waits a full interval after the snooze ends', () => {
		const until = DUE_AT + 60 * ONE_MINUTE;
		snoozeGuildReminder('g1', 'water', { until, skipMissed: true, now: DUE_AT });

		expect(getDueGuildReminders(until)).toHaveLength(0);
		expect(getDueGuildReminders(until + 10 * ONE_MINUTE - 1)).toHaveLength(0);
		expect(getDueGuildReminders(until + 10 * ONE_MINUTE)).toHaveLength(1);
	});

	it('cancelling a snooze makes a missed reminder due again at once', () => {
		snoozeGuildReminder('g1', 'water', { until: DUE_AT + 60 * ONE_MINUTE, skipMissed: false, now: DUE_AT });
		unsnoozeGuildReminder('g1', 'water', DUE_AT + ONE_MINUTE);

		expect(getGuildReminderByLabel('g1', 'water')?.snoozed_until).toBe(0);
		expect(getDueGuildReminders(DUE_AT + ONE_MINUTE)).toHaveLength(1);
	});

	it('cancelling a skipMissed snooze early counts the interval from the cancel', () => {
		const cancelAt = DUE_AT + 5 * ONE_MINUTE;
		snoozeGuildReminder('g1', 'water', { until: DUE_AT + 60 * ONE_MINUTE, skipMissed: true, now: DUE_AT });
		unsnoozeGuildReminder('g1', 'water', cancelAt);

		expect(getGuildReminderByLabel('g1', 'water')?.last_sent_at).toBe(cancelAt);
		expect(getDueGuildReminders(cancelAt + 10 * ONE_MINUTE - 1)).toHaveLength(0);
		expect(getDueGuildReminders(cancelAt + 10 * ONE_MINUTE)).toHaveLength(1);
	});

	it('re-snoozing without skipMissed drops an earlier skipMissed snooze’s future last_sent_at', () => {
		const resnoozeAt = DUE_AT + 5 * ONE_MINUTE;
		const until = resnoozeAt + 30 * ONE_MINUTE;
		snoozeGuildReminder('g1', 'water', { until: DUE_AT + 60 * ONE_MINUTE, skipMissed: true, now: DUE_AT });
		snoozeGuildReminder('g1', 'water', { until, skipMissed: false, now: resnoozeAt });

		expect(getGuildReminderByLabel('g1', 'water')?.last_sent_at).toBe(resnoozeAt);
		expect(getDueGuildReminders(until)).toHaveLength(1);
	});

	it('only touches the named reminder', () => {
		createGuildReminder({ guildId: 'g1', label: 'stretch', channelId: 'c1', intervalMinutes: 10, message: 'hi' });
		updateGuildReminderLastSent(reminderId('stretch'), SENT_AT);
		snoozeGuildReminder('g1', 'water', { until: DUE_AT + 60 * ONE_MINUTE, skipMissed: false, now: DUE_AT });

		expect(getDueGuildReminders(DUE_AT).map((r) => r.reminder_label)).toEqual(['stretch']);
	});
});

describe('user DM snooze', () => {
	it('starts unsnoozed', () => {
		expect(getUserSettings('u1')?.snoozed_until).toBe(0);
	});

	it('holds back a due DM until the snooze ends, then sends the missed one', () => {
		const until = DUE_AT + 60 * ONE_MINUTE;
		snoozeUser('u1', { until, skipMissed: false, now: DUE_AT });

		expect(getDueUserSettings(until - 1)).toHaveLength(0);
		expect(getDueUserSettings(until)).toHaveLength(1);
	});

	it('with skipMissed, waits a full interval after the snooze ends', () => {
		const until = DUE_AT + 60 * ONE_MINUTE;
		snoozeUser('u1', { until, skipMissed: true, now: DUE_AT });

		expect(getDueUserSettings(until)).toHaveLength(0);
		expect(getDueUserSettings(until + 10 * ONE_MINUTE)).toHaveLength(1);
	});

	it('cancelling a snooze makes a missed DM due again at once', () => {
		snoozeUser('u1', { until: DUE_AT + 60 * ONE_MINUTE, skipMissed: false, now: DUE_AT });
		unsnoozeUser('u1', DUE_AT + ONE_MINUTE);

		expect(getUserSettings('u1')?.snoozed_until).toBe(0);
		expect(getDueUserSettings(DUE_AT + ONE_MINUTE)).toHaveLength(1);
	});

	it('keeps the snooze when the other settings are updated', () => {
		const until = DUE_AT + 60 * ONE_MINUTE;
		snoozeUser('u1', { until, skipMissed: false, now: DUE_AT });
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 15, message: 'new', embed: true });

		expect(getUserSettings('u1')?.snoozed_until).toBe(until);
	});
});
