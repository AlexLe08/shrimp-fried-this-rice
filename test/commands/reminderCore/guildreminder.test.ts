import { describe, it, expect, vi, beforeEach } from 'vitest';
import guildReminderCommand from '../../../src/commands/reminderCore/guildreminder.ts';
import {
	getGuildReminderByLabel,
	getGuildSettings,
	setGuildStatusMessage,
	__resetForTests,
} from '../../../src/storage.ts';
import { createMockInteraction } from '../../mockInteraction.ts';
import { createMockChannel } from '../../mocks.ts';

beforeEach(() => {
	__resetForTests();
});

function makePermissiveChannel() {
	const channel = createMockChannel();
    // Mock the permissionsFor method to always return an object with a has method that returns true
	(channel as Record<string, unknown>)['permissionsFor'] = vi.fn(() => ({ has: () => true }));
	return channel;
}

function makeRestrictedChannel() {
	const channel = createMockChannel();
	(channel as Record<string, unknown>)['permissionsFor'] = vi.fn(() => ({ has: () => false }));
	return channel;
}

function makeGuild(membersMe: unknown = {}) {
	return { id: 'g1', name: 'Test Guild', members: { me: membersMe } };
}

async function createBaseline() {
    const channel = makePermissiveChannel();
    const interaction = createMockInteraction({
        inCachedGuild: true,
        guild: makeGuild(),
        options: {
            subcommand: 'create',
            strings: { label: 'water', message: 'original' },
            channels: { channel },
            integers: { interval: 60 },
        },
    });
    await guildReminderCommand.execute(interaction as never);
}

describe('/reminder create', () => {
	it('creates a reminder and confirms, with no permission warning when permissions are fine', async () => {
		const channel = makePermissiveChannel();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: {
				subcommand: 'create',
				strings: { label: 'water', message: 'Drink water!' },
				channels: { channel },
				integers: { interval: 60 },
			},
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'water')).toBeDefined();
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.not.stringContaining('⚠️') }),
		);
	});

	it('rejects a duplicate label', async () => {
		const channel = makePermissiveChannel();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: {
				subcommand: 'create',
				strings: { label: 'water', message: 'hi' },
				channels: { channel },
				integers: { interval: 60 },
			},
		});

        // First execution should succeed, second execution with the same label should be rejected
		await guildReminderCommand.execute(interaction as never);
		await guildReminderCommand.execute(interaction as never);

        // We expect the second execution to have been rejected with a message indicating that the label already exists
		expect(interaction.reply).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining('already exists') }),
		);
	});

	it('warns but still saves when the bot lacks channel permissions', async () => {
		const channel = makeRestrictedChannel();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: {
				subcommand: 'create',
				strings: { label: 'water', message: 'hi' },
				channels: { channel },
				integers: { interval: 60 },
			},
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'water')).toBeDefined();
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('missing these permissions') }),
		);
	});
});

describe('/reminder list', () => {
	it('shows the default master-enabled state for a guild that never set it', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'list' },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildSettings('g1')).toBeUndefined(); // confirms no row was created just by listing
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('Master toggle:** enabled') }),
		);
	});

	it('shows a helpful message when there are no reminders yet', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'list' },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('no reminders configured') }),
		);
	});
});

describe('/reminder edit', () => {
	it('rejects when no fields are provided', async () => {
		await createBaseline();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'edit', strings: { label: 'water' } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('at least one field') }),
		);
	});

	it('rejects editing a nonexistent label', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'edit', strings: { label: 'nonexistent' }, integers: { interval: 30 } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('No reminder found') }),
		);
	});

	it('updates only the specified field, leaving the rest unchanged', async () => {
		await createBaseline();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'edit', strings: { label: 'water' }, integers: { interval: 15 } },
		});

		await guildReminderCommand.execute(interaction as never);

		const updated = getGuildReminderByLabel('g1', 'water');
		expect(updated?.interval_minutes).toBe(15);
		expect(updated?.message).toBe('original');
	});
});

describe('/reminder toggle', () => {
	it('rejects toggling a nonexistent label', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'toggle', strings: { label: 'nonexistent' }, booleans: { enabled: false } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('No reminder found') }),
		);
	});

    it('enables/disables the reminder and confirms', async () => {
		await createBaseline();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'toggle', strings: { label: 'water' }, booleans: { enabled: false } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'water')?.enabled).toBe(0);
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('now disabled') }),
		);
	});
});

describe('/reminder delete', () => {
	it('rejects deleting a nonexistent label', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'delete', strings: { label: 'nonexistent' } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('No reminder found') }),
		);
	});

    it('removes the reminder and confirms', async () => {
		await createBaseline();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'delete', strings: { label: 'water' } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'water')).toBeUndefined();
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('Deleted reminder') }),
		);
	});
});

describe('/reminder master', () => {
	it('updates the master toggle and confirms', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'master', booleans: { enabled: false } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildSettings('g1')?.master_enabled).toBe(0);
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('now disabled') }),
		);
	});
});

describe('/reminder status', () => {
	it('rejects when the current channel is not sendable', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			channel: null,
			options: { subcommand: 'status' },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('text channel') }),
		);
	});

	it('posts a new status embed and tracks it', async () => {
		const postChannel = createMockChannel();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			channel: postChannel,
			options: { subcommand: 'status' },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(postChannel.send).toHaveBeenCalled();
		expect(interaction.deferReply).toHaveBeenCalled();
		expect(interaction.editReply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('Posted!') }),
		);
	});

	it('deletes the previously-tracked status message before posting a new one', async () => {
		setGuildStatusMessage('g1', 'old-channel', 'old-message');
		const deleteFn = vi.fn().mockResolvedValue(undefined);
		const oldChannel = createMockChannel();
		oldChannel.messages.fetch.mockResolvedValue({ delete: deleteFn });

		const newChannel = createMockChannel();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			channel: newChannel,
			client: {
				commands: new Map() as never,
				cooldowns: new Map() as never,
				channels: { fetch: vi.fn().mockResolvedValue(oldChannel) },
			} as never,
			options: { subcommand: 'status' },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(deleteFn).toHaveBeenCalled();
		expect(newChannel.send).toHaveBeenCalled();
	});

	it('still posts the new embed even if deleting the old one fails', async () => {
		setGuildStatusMessage('g1', 'old-channel', 'old-message');
		const newChannel = createMockChannel();
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			channel: newChannel,
			client: {
				commands: new Map() as never,
				cooldowns: new Map() as never,
				channels: { fetch: vi.fn().mockRejectedValue(new Error('gone')) },
			} as never,
			options: { subcommand: 'status' },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(consoleSpy).toHaveBeenCalled();
		expect(newChannel.send).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});
