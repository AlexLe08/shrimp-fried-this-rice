import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Collection, PermissionFlagsBits } from 'discord.js';
import guildReminderCommand from '../../../src/reminders/commands/reminder.ts';
import {
	getGuildReminderByLabel,
	getGuildSettings,
	setGuildStatusMessage,
	MAX_REMINDERS_PER_GUILD,
	__resetForTests,
} from '../../../src/storage.ts';
import { createMockInteraction } from '../../mockInteraction.ts';
import { createMockChannel } from '../../mocks.ts';

beforeEach(() => {
	__resetForTests();
});

function makePermissiveChannel() {
	const channel = createMockChannel();
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

	it('rejects creating a reminder once the guild has reached the maximum', async () => {
		const channel = makePermissiveChannel();

		for (let i = 0; i < MAX_REMINDERS_PER_GUILD; i++) {
			const interaction = createMockInteraction({
				inCachedGuild: true,
				guild: makeGuild(),
				options: {
					subcommand: 'create',
					strings: { label: `reminder-${i}`, message: 'hi' },
					channels: { channel },
					integers: { interval: 60 },
				},
			});
			await guildReminderCommand.execute(interaction as never);
		}

		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: {
				subcommand: 'create',
				strings: { label: 'one-too-many', message: 'hi' },
				channels: { channel },
				integers: { interval: 60 },
			},
		});
		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'one-too-many')).toBeUndefined();
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('maximum') }),
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

		await guildReminderCommand.execute(interaction as never);
		await guildReminderCommand.execute(interaction as never);

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

	it('says a reminder goes out as plain text where the bot can send but not embed links', async () => {
		const channel = createMockChannel();
		(channel as Record<string, unknown>)['permissionsFor'] = vi.fn(() => ({
			has: (permission: bigint) => permission !== PermissionFlagsBits.EmbedLinks,
		}));
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

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('sent as plain text until I can') }),
		);
		// It still sends, so it mustn't say it won't.
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.not.stringContaining("won't send") }),
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

describe('/reminder embed option', () => {
	it('create saves plain text when embed is false, and says so', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: {
				subcommand: 'create',
				strings: { label: 'water', message: 'hi' },
				channels: { channel: makePermissiveChannel() },
				integers: { interval: 60 },
				booleans: { embed: false },
			},
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'water')?.embed).toBe(0);
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('as plain text') }),
		);
	});

	it('create defaults to an embed', async () => {
		await createBaseline();

		expect(getGuildReminderByLabel('g1', 'water')?.embed).toBe(1);
	});

	it('edit accepts embed as the only field to change', async () => {
		await createBaseline();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'edit', strings: { label: 'water' }, booleans: { embed: false } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'water')).toMatchObject({ embed: 0, message: 'original' });
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('updated') }),
		);
	});

	it('list marks plain-text reminders', async () => {
		await createBaseline();
		const edit = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: { subcommand: 'edit', strings: { label: 'water' }, booleans: { embed: false } },
		});
		await guildReminderCommand.execute(edit as never);

		const list = createMockInteraction({ inCachedGuild: true, guild: makeGuild(), options: { subcommand: 'list' } });
		await guildReminderCommand.execute(list as never);

		expect(list.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('enabled, plain text') }),
		);
	});

	function makeNoEmbedChannel() {
		const channel = createMockChannel();
		(channel as Record<string, unknown>)['permissionsFor'] = vi.fn(() => ({
			has: (permission: bigint) => permission !== PermissionFlagsBits.EmbedLinks,
		}));
		return channel;
	}

	it("doesn't warn about Embed Links for a plain-text reminder", async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: {
				subcommand: 'create',
				strings: { label: 'water', message: 'hi' },
				channels: { channel: makeNoEmbedChannel() },
				integers: { interval: 60 },
				booleans: { embed: false },
			},
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.not.stringContaining('⚠️') }),
		);
	});

	it("warns when edit switches to an embed in a channel where the bot can't embed", async () => {
		const channel = makeNoEmbedChannel();
		const create = createMockInteraction({
			inCachedGuild: true,
			guild: makeGuild(),
			options: {
				subcommand: 'create',
				strings: { label: 'water', message: 'hi' },
				channels: { channel },
				integers: { interval: 60 },
				booleans: { embed: false },
			},
		});
		await guildReminderCommand.execute(create as never);
		const savedChannelId = getGuildReminderByLabel('g1', 'water')!.channel_id;

		const edit = createMockInteraction({
			inCachedGuild: true,
			guild: { ...makeGuild(), channels: { cache: new Map([[savedChannelId, channel]]) } },
			options: { subcommand: 'edit', strings: { label: 'water' }, booleans: { embed: true } },
		});
		await guildReminderCommand.execute(edit as never);

		expect(edit.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('sent as plain text until I can') }),
		);
	});
});

describe('/reminder custom emoji', () => {
	// The bot is in g1 (with :shrimp:) and g2 (with :other:), not in the
	// server :gone: comes from.
	function emojiClient() {
		const cache = new Collection([
			['111', { id: '111', available: true, guild: { id: 'g1', name: 'Test Guild' } }],
			['222', { id: '222', available: true, guild: { id: 'g2', name: 'Other Guild' } }],
		]);
		return { emojis: { cache } };
	}

	function makeChannelWithoutExternalEmojis() {
		const channel = createMockChannel();
		(channel as Record<string, unknown>)['permissionsFor'] = vi.fn(() => ({
			has: (permission: bigint) => permission !== PermissionFlagsBits.UseExternalEmojis,
		}));
		return channel;
	}

	function guildWithChannels(...channels: { id: string }[]) {
		return { ...makeGuild(), channels: { cache: new Collection(channels.map((c) => [c.id, c])) } };
	}

	async function createWith(message: string, channel: { id: string }) {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: guildWithChannels(channel),
			client: emojiClient(),
			options: {
				subcommand: 'create',
				strings: { label: 'water', message },
				channels: { channel },
				integers: { interval: 60 },
			},
		});
		await guildReminderCommand.execute(interaction as never);
		return interaction;
	}

	it("create warns, but saves, when an emoji is from a server the bot isn't in", async () => {
		const interaction = await createWith('hi <:gone:999>', makePermissiveChannel());

		expect(getGuildReminderByLabel('g1', 'water')?.message).toBe('hi <:gone:999>');
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("server I'm not in") }),
		);
	});

	it('create warns about another server’s emoji where the bot lacks Use External Emojis', async () => {
		const channel = makeChannelWithoutExternalEmojis();
		const interaction = await createWith('<:other:222> and <:shrimp:111>', channel);

		const content = (interaction.reply.mock.calls[0]![0] as { content: string }).content;
		expect(content).toContain(
			`from another server, **Other Guild**, and I don't have Use External Emojis in <#${channel.id}>`,
		);
		expect(content).toContain('`:other:`');
		expect(content).not.toContain('`:shrimp:`');
	});

	it('edit warns about a new message’s emoji', async () => {
		const channel = makePermissiveChannel();
		await createWith('original', channel);
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: guildWithChannels(channel),
			client: emojiClient(),
			options: { subcommand: 'edit', strings: { label: 'water', message: 'now <:gone:999>' } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("server I'm not in") }),
		);
	});

	it('edit warns when a new channel lacks Use External Emojis for the saved message', async () => {
		await createWith('<:other:222>', makePermissiveChannel());
		const moved = makeChannelWithoutExternalEmojis();
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: guildWithChannels(moved),
			client: emojiClient(),
			options: { subcommand: 'edit', strings: { label: 'water' }, channels: { channel: moved } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('Use External Emojis') }),
		);
	});

	it('edit checks a new message against the saved channel', async () => {
		const channel = makeChannelWithoutExternalEmojis();
		await createWith('original', channel);
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: guildWithChannels(channel),
			client: emojiClient(),
			options: { subcommand: 'edit', strings: { label: 'water', message: '<:other:222>' } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('Use External Emojis') }),
		);
	});

	it("edit doesn't guess about Use External Emojis when the saved channel isn't cached", async () => {
		await createWith('original', makeChannelWithoutExternalEmojis());
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: guildWithChannels(),
			client: emojiClient(),
			options: { subcommand: 'edit', strings: { label: 'water', message: '<:other:222> <:gone:999>' } },
		});

		await guildReminderCommand.execute(interaction as never);

		const content = (interaction.reply.mock.calls[0]![0] as { content: string }).content;
		expect(content).not.toContain('Use External Emojis');
		expect(content).toContain('`:gone:`');
	});

	it("edit doesn't repeat the warning when neither the message nor the channel changes", async () => {
		const channel = makePermissiveChannel();
		await createWith('<:gone:999>', channel);
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: guildWithChannels(channel),
			client: emojiClient(),
			options: { subcommand: 'edit', strings: { label: 'water' }, integers: { interval: 15 } },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith({
			content: 'Reminder `water` updated.',
			flags: expect.anything(),
		});
	});
});
