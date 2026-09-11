// test/reminderEmbed.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiscordAPIError, type Client } from 'discord.js';
import { buildReminderStatusEmbed, refreshGuildStatusMessage } from '../src/reminderEmbed.ts';
import {
	createGuildReminder,
	updateGuildReminderLastSent,
	setGuildReminderEnabled,
	setGuildMasterEnabled,
	setGuildStatusMessage,
	getGuildStatusMessage,
	__resetForTests,
} from '../src/storage.ts';
import { createMockClient, createMockChannel } from './mocks.ts';

beforeEach(() => {
	__resetForTests();
});

describe('buildReminderStatusEmbed', () => {
	it('shows a placeholder description when there are no reminders', () => {
		const embed = buildReminderStatusEmbed('guild-1', 'Test Server').toJSON();
		expect(embed.description).toContain('No reminders configured yet');
	});

    it('lists a reminder with a "next fire" relative timestamp when it is not yet due', () => {
        createGuildReminder({ guildId: 'guild-1', label: 'water', channelId: 'chan-1', intervalMinutes: 1440, message: 'hi' });
        updateGuildReminderLastSent(1, Date.now()); // "just sent" — not due again for another 1440 minutes

        const embed = buildReminderStatusEmbed('guild-1', 'Test Server').toJSON();
        expect(embed.description).toContain('`water`');
        expect(embed.description).toMatch(/next <t:\d+:R>/);
    });

	it('shows "due on next check" for a brand-new reminder', () => {
		createGuildReminder({ guildId: 'guild-1', label: 'water', channelId: 'chan-1', intervalMinutes: 60, message: 'hi' });

		const embed = buildReminderStatusEmbed('guild-1', 'Test Server').toJSON();
		expect(embed.description).toContain('due on next check');
	});

	it('marks an individually-disabled reminder as disabled', () => {
		createGuildReminder({ guildId: 'guild-1', label: 'water', channelId: 'chan-1', intervalMinutes: 60, message: 'hi' });
		setGuildReminderEnabled('guild-1', 'water', false);

		const embed = buildReminderStatusEmbed('guild-1', 'Test Server').toJSON();
		expect(embed.description).toContain('⏸ disabled');
	});

	it('marks all reminders as paused when the master toggle is off, and uses the red color', () => {
		createGuildReminder({ guildId: 'guild-1', label: 'water', channelId: 'chan-1', intervalMinutes: 60, message: 'hi' });
		setGuildMasterEnabled('guild-1', false);

		const embed = buildReminderStatusEmbed('guild-1', 'Test Server').toJSON();
		expect(embed.description).toContain('paused (server master toggle is off)');
		expect(embed.color).toBe(0xed4245);
	});
});

describe('refreshGuildStatusMessage', () => {
	it('does nothing if no status message is tracked for the guild', async () => {
		const client = createMockClient();
		await refreshGuildStatusMessage(client as unknown as Client, 'guild-1');
		expect(client.channels.fetch).not.toHaveBeenCalled();
	});

	it('edits the tracked message with a freshly built embed', async () => {
		createGuildReminder({ guildId: 'guild-1', label: 'water', channelId: 'chan-1', intervalMinutes: 60, message: 'hi' });
		setGuildStatusMessage('guild-1', 'chan-1', 'msg-1');

		const editMock = vi.fn().mockResolvedValue(undefined);
		const channel = createMockChannel();
		channel.messages.fetch.mockResolvedValue({ edit: editMock });

		const client = createMockClient({
			channels: { 'chan-1': channel },
			guilds: { 'guild-1': { name: 'Test Server' } },
		});

        // refreshGuildStatusMessage is async, so we need to await it to ensure the edit has been called
        // double type cast to satisfy the Client type, since our mock doesn't implement all methods
		await refreshGuildStatusMessage(client as unknown as Client, 'guild-1');

		expect(editMock).toHaveBeenCalledTimes(1);
		expect(editMock.mock.calls[0]?.[0].embeds[0]).toBeDefined();
	});

	it('clears the tracked status message when Discord reports it no longer exists (10008)', async () => {
		createGuildReminder({ guildId: 'guild-1', label: 'water', channelId: 'chan-1', intervalMinutes: 60, message: 'hi' });
		setGuildStatusMessage('guild-1', 'chan-1', 'msg-1');

		const channel = createMockChannel();
		channel.messages.fetch.mockRejectedValue(
			new DiscordAPIError({ message: 'Unknown Message', code: 10008 }, 10008, 404, 'GET', 'https://discord.com/api/v10/mock', {}),
		);

		const client = createMockClient({
			channels: { 'chan-1': channel },
			guilds: { 'guild-1': { name: 'Test Server' } },
		});

		await refreshGuildStatusMessage(client as unknown as Client, 'guild-1');

		expect(getGuildStatusMessage('guild-1')).toBeUndefined();
	});

	it('logs but keeps tracking on a transient/unrelated error', async () => {
		createGuildReminder({ guildId: 'guild-1', label: 'water', channelId: 'chan-1', intervalMinutes: 60, message: 'hi' });
		setGuildStatusMessage('guild-1', 'chan-1', 'msg-1');

		const channel = createMockChannel();
		channel.messages.fetch.mockRejectedValue(new Error('temporary network blip'));

		const client = createMockClient({
			channels: { 'chan-1': channel },
			guilds: { 'guild-1': { name: 'Test Server' } },
		});
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await refreshGuildStatusMessage(client as unknown as Client, 'guild-1');

		expect(getGuildStatusMessage('guild-1')).toBeDefined(); // still tracked, not cleared
		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});