import { vi } from 'vitest';
import { Collection } from 'discord.js';

export interface MockOptionsConfig {
	strings?: Record<string, string | null>;
	integers?: Record<string, number | null>;
	booleans?: Record<string, boolean | null>;
	channels?: Record<string, unknown>;
	roles?: Record<string, unknown>;
	subcommand?: string;
}

interface MockInteractionConfig {
	options?: MockOptionsConfig;
	inCachedGuild?: boolean;
	guild?: Record<string, unknown> | null;
	user?: { id: string; username: string };
	// Server-wide permissions of whoever runs it; allows everything unless given.
	memberPermissions?: { has(permission: bigint): boolean };
	channel?: unknown;
	client?: { commands?: Collection<string, unknown>; cooldowns?: Collection<string, unknown>; emojis?: unknown };
	replied?: boolean;
	deferred?: boolean;
	isChatInputCommand?: boolean;
	isAutocomplete?: boolean;
	focused?: string;
	commandName?: string;
}

export function createMockInteraction(config: MockInteractionConfig = {}) {
	const options = config.options ?? {};

	return {
		guildId: (config.guild?.['id'] as string | undefined) ?? null,
		guild: config.guild ?? null,
		user: config.user ?? { id: 'mock-user-id', username: 'mockuser' },
		member: { id: config.user?.id ?? 'mock-user-id' },
		memberPermissions: config.memberPermissions ?? { has: () => true },
		channel: config.channel ?? null,
		client: config.client ?? {
			commands: new Collection<string, unknown>(),
			cooldowns: new Collection<string, unknown>(),
		},
		replied: config.replied ?? false,
		deferred: config.deferred ?? false,
		isChatInputCommand: vi.fn(() => config.isChatInputCommand ?? true),
		isAutocomplete: vi.fn(() => config.isAutocomplete ?? false),
		commandName: config.commandName ?? 'mock-command',

		inCachedGuild: vi.fn(() => config.inCachedGuild ?? true),

		options: {
			getString: vi.fn((name: string) => options.strings?.[name] ?? null),
			getInteger: vi.fn((name: string) => options.integers?.[name] ?? null),
			getBoolean: vi.fn((name: string) => options.booleans?.[name] ?? null),
			getChannel: vi.fn((name: string) => options.channels?.[name] ?? null),
			getRole: vi.fn((name: string) => options.roles?.[name] ?? null),
			getSubcommand: vi.fn(() => options.subcommand ?? ''),
			getFocused: vi.fn(() => config.focused ?? ''),
		},

		reply: vi.fn().mockResolvedValue(undefined),
		respond: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	};
}

export function replyContent(interaction: ReturnType<typeof createMockInteraction>): string {
	const [[reply]] = interaction.reply.mock.calls as [[{ content: string }]];
	return reply.content;
}
