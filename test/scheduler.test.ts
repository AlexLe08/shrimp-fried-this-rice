import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from 'discord.js';
import { startScheduler } from '../src/scheduler.ts';
import { createGuildReminder, updateGuildReminderLastSent, upsertUserSettings, updateUserLastSent, getGuildReminderByLabel, getUserSettings, __resetForTests } from '../src/storage.ts';
import { createMockClient, createMockChannel, createMockUser } from './mocks.ts';

// Using fake timers to control the passage of time in tests
beforeEach(() => {
	__resetForTests();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('scheduler — guild reminders', () => {
	it('sends a due reminder to its channel and updates last_sent_at', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 5, message: 'Drink water!' });

		const channel = createMockChannel();
		const client = createMockClient({ channels: { c1: channel } });

        // checkGuildReminders is async, so we need to await the scheduler's execution after advancing the timersh
		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(channel.send).toHaveBeenCalledWith('Drink water!');
		expect(getGuildReminderByLabel('g1', 'water')?.last_sent_at).toBeGreaterThan(0);
	});

	it('logs an error and does not throw when the channel is not found', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'missing-channel', intervalMinutes: 5, message: 'hi' });
		const client = createMockClient({ channels: { 'missing-channel': null } });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('does not send to a channel that is not sendable', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 5, message: 'hi' });
		const channel = createMockChannel({ sendable: false });
		const client = createMockClient({ channels: { c1: channel } });

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(channel.send).not.toHaveBeenCalled();
	});

	it('continues processing remaining reminders even if one fails to send', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 5, message: 'first' });
		createGuildReminder({ guildId: 'g1', label: 'posture', channelId: 'c2', intervalMinutes: 5, message: 'second' });

		const failingChannel = createMockChannel();
		failingChannel.send.mockRejectedValueOnce(new Error('network error'));
		const workingChannel = createMockChannel();

		const client = createMockClient({ channels: { c1: failingChannel, c2: workingChannel } });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(workingChannel.send).toHaveBeenCalledWith('second');
	});
});

describe('scheduler — user DM reminders', () => {
	it('sends a due DM reminder and updates last_sent_at', async () => {
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 5, message: 'Drink water!' });

		const user = createMockUser();
		const client = createMockClient({ users: { u1: user } });

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(user.send).toHaveBeenCalledWith('Drink water!');
		expect(getUserSettings('u1')?.last_sent_at).toBeGreaterThan(0);
	});

	it('logs an error and does not throw when a DM fails to send', async () => {
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 5, message: 'hi' });
		const user = createMockUser({ sendShouldFail: true });
		const client = createMockClient({ users: { u1: user } });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});