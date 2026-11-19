import { describe, it, expect, beforeEach } from 'vitest';
import {
	createGuildReminder,
	getGuildReminderByLabel,
	getGuildReminders,
	updateGuildReminder,
	setGuildReminderEnabled,
	deleteGuildReminder,
	disableGuildReminderForChannel,
	updateGuildReminderLastSentForChannel,
	__resetForTests,
} from '../../src/storage.ts';

beforeEach(() => {
	__resetForTests();
});

function makeReminder(overrides: Partial<Parameters<typeof createGuildReminder>[0]> = {}) {
	createGuildReminder({
		guildId: 'guild-1',
		label: 'water',
		channelId: 'channel-1',
		intervalMinutes: 60,
		message: 'Drink water!',
		...overrides,
	});
}

describe('createGuildReminder', () => {
	it('rejects a duplicate label within the same guild', () => {
		makeReminder();
		expect(() => makeReminder()).toThrow();
	});

	it('allows the same label across two different guilds', () => {
		makeReminder({ guildId: 'guild-1' });
		expect(() => makeReminder({ guildId: 'guild-2' })).not.toThrow();
	});
});

describe('getGuildReminders', () => {
	it('only returns reminders for the requested guild', () => {
		makeReminder({ guildId: 'guild-1', label: 'water' });
		makeReminder({ guildId: 'guild-2', label: 'posture' });

		const guild1Reminders = getGuildReminders('guild-1');
		expect(guild1Reminders).toHaveLength(1);
		expect(guild1Reminders[0]?.reminder_label).toBe('water');
	});
});

describe('updateGuildReminder', () => {
    it('updates only the specified fields, leaving others untouched', () => {
        makeReminder(); // baseline: interval 60, message 'Drink water!'

        updateGuildReminder('guild-1', 'water', { intervalMinutes: 30 });

        const updated = getGuildReminderByLabel('guild-1', 'water');
        expect(updated?.interval_minutes).toBe(30);
        expect(updated?.message).toBe('Drink water!'); // unchanged
    });

	it('does nothing if the reminder does not exist', () => {
		expect(() => updateGuildReminder('guild-1', 'nonexistent', { intervalMinutes: 10 })).not.toThrow();
		expect(getGuildReminderByLabel('guild-1', 'nonexistent')).toBeUndefined();
	});
});

describe('setGuildReminderEnabled / deleteGuildReminder', () => {
	it('toggles enabled state', () => {
		makeReminder();
		setGuildReminderEnabled('guild-1', 'water', false);
		expect(getGuildReminderByLabel('guild-1', 'water')?.enabled).toBe(0);
	});

	it('removes the reminder entirely', () => {
		makeReminder();
		deleteGuildReminder('guild-1', 'water');
		expect(getGuildReminderByLabel('guild-1', 'water')).toBeUndefined();
	});
});
describe('disableGuildReminderForChannel / updateGuildReminderLastSentForChannel', () => {
	it('change the reminder while it still points at the given channel', () => {
		makeReminder();
		const { id, channel_id } = getGuildReminderByLabel('guild-1', 'water')!;

		updateGuildReminderLastSentForChannel(id, channel_id, 1234);
		disableGuildReminderForChannel(id, channel_id);

		const after = getGuildReminderByLabel('guild-1', 'water')!;
		expect(after.last_sent_at).toBe(1234);
		expect(after.enabled).toBe(0);
	});

	it('leave the reminder alone once it was moved to another channel', () => {
		makeReminder();
		const { id, channel_id } = getGuildReminderByLabel('guild-1', 'water')!;
		updateGuildReminder('guild-1', 'water', { channelId: 'another-channel' });

		updateGuildReminderLastSentForChannel(id, channel_id, 1234);
		disableGuildReminderForChannel(id, channel_id);

		const after = getGuildReminderByLabel('guild-1', 'water')!;
		expect(after.last_sent_at).toBe(0);
		expect(after.enabled).toBe(1);
	});
});
