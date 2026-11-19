import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAPIError, type Client } from 'discord.js';
import { startScheduler, stopScheduler } from '../src/scheduler.ts';
import { createGuildReminder, updateGuildReminderLastSent, upsertUserSettings, updateUserLastSent, getGuildReminderByLabel, getUserSettings, __resetForTests } from '../src/storage.ts';
import { createMockClient, createMockChannel, createMockUser } from './mocks.ts';

// Using fake timers to control the passage of time in tests
beforeEach(() => {
	__resetForTests();
	vi.useFakeTimers();
});

afterEach(() => {
	stopScheduler();
	vi.useRealTimers();
});

function discordError(code: number, status: number): DiscordAPIError {
	return new DiscordAPIError({ message: 'mock', code }, code, status, 'POST', 'https://discord.com/api/v10/mock', {});
}

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

	it('disables a reminder whose channel no longer exists', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'gone', intervalMinutes: 5, message: 'hi' });
		const client = createMockClient({ channels: { gone: null } });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(getGuildReminderByLabel('g1', 'water')?.enabled).toBe(0);
	});

	it('disables a reminder whose channel cannot take messages', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 5, message: 'hi' });
		const client = createMockClient({ channels: { c1: createMockChannel({ sendable: false }) } });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(getGuildReminderByLabel('g1', 'water')?.enabled).toBe(0);
	});

	it('disables a reminder when Discord says its channel is unknown', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 5, message: 'hi' });
		const client = createMockClient();
		client.channels.fetch.mockRejectedValue(discordError(10003, 404));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(getGuildReminderByLabel('g1', 'water')?.enabled).toBe(0);
	});

	it('waits a full interval before retrying a send Discord refused', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 5, message: 'hi' });
		const channel = createMockChannel();
		channel.send.mockRejectedValue(discordError(50013, 403)); // Missing Permissions
		const client = createMockClient({ channels: { c1: channel } });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		// First attempt at the 1-minute poll; the next is due 5 minutes later.
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(channel.send).toHaveBeenCalledTimes(1);
		expect(getGuildReminderByLabel('g1', 'water')?.enabled).toBe(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(channel.send).toHaveBeenCalledTimes(2);
	});

	it.each([
		['a network error', new Error('network error')],
		['a Discord server error', discordError(0, 503)],
		['a rate limit', discordError(0, 429)],
	])('retries on the next poll after %s', async (_name, error) => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 5, message: 'hi' });
		const channel = createMockChannel();
		channel.send.mockRejectedValueOnce(error);
		const client = createMockClient({ channels: { c1: channel } });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(2 * 60_000);

		expect(channel.send).toHaveBeenCalledTimes(2);
		expect(getGuildReminderByLabel('g1', 'water')?.enabled).toBe(1);
	});

	it('stopScheduler clears the interval so no further polling occurs', async () => {
		createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 5, message: 'hi' });
		const channel = createMockChannel();
		const client = createMockClient({ channels: { c1: channel } });

		startScheduler(client as unknown as Client<true>);
		stopScheduler();

		await vi.advanceTimersByTimeAsync(120_000);

		expect(channel.send).not.toHaveBeenCalled();
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

	it('waits a full interval before retrying a DM Discord refused', async () => {
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 5, message: 'hi' });
		const user = createMockUser();
		user.send.mockRejectedValue(discordError(50007, 403)); // Cannot send messages to this user
		const client = createMockClient({ users: { u1: user } });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		// First attempt at the 1-minute poll; the next is due 5 minutes later.
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(user.send).toHaveBeenCalledTimes(1);
		expect(getUserSettings('u1')?.dm_enabled).toBe(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(user.send).toHaveBeenCalledTimes(2);
	});

	it('retries a DM on the next poll after a network error', async () => {
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 5, message: 'hi' });
		const user = createMockUser();
		user.send.mockRejectedValueOnce(new Error('network error'));
		const client = createMockClient({ users: { u1: user } });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(client as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(2 * 60_000);

		expect(user.send).toHaveBeenCalledTimes(2);
	});
});
