import { describe, it, expect, beforeEach } from 'vitest';
import { createGuildReminder, getGuildReminderByLabel, __resetForTests } from '../src/storage.ts';

// Reset the database before each test
beforeEach(() => {
	__resetForTests();
});

describe('createGuildReminder', () => {
	it('creates a reminder that can be retrieved by its label', () => {
		createGuildReminder({
			guildId: 'guild-1',
			label: 'water',
			channelId: 'channel-1',
			intervalMinutes: 60,
			message: 'Drink water!',
		});

		const reminder = getGuildReminderByLabel('guild-1', 'water');

		expect(reminder).toBeDefined();
		expect(reminder?.message).toBe('Drink water!');
		expect(reminder?.enabled).toBe(1);
	});
});