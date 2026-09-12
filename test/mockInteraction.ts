import { vi } from 'vitest';
import { Collection } from 'discord.js';

interface MockOptionsConfig {
	strings?: Record<string, string | null>;
	integers?: Record<string, number | null>;
	booleans?: Record<string, boolean | null>;
	channels?: Record<string, unknown>;
	users?: Record<string, unknown>;
	subcommand?: string;
}

interface MockInteractionConfig {
	options?: MockOptionsConfig;
	inCachedGuild?: boolean;
	inGuild?: boolean;
	guild?: Record<string, unknown> | null;
	member?: Record<string, unknown> | null;
	user?: { id: string; username: string };
	channel?: unknown;
	client?: { commands?: Collection<string, unknown>; cooldowns?: Collection<string, unknown> };
	replied?: boolean;
	deferred?: boolean;
    isChatInputCommand?: boolean;
    commandName?: string;
}

export function createMockInteraction(config: MockInteractionConfig = {}) {
	const options = config.options ?? {};

	return {
		guildId: (config.guild?.['id'] as string | undefined) ?? null,
		guild: config.guild ?? null,
		member: config.member ?? null,
		user: config.user ?? { id: 'mock-user-id', username: 'mockuser' },
		channel: config.channel ?? null,
		client: config.client ?? { commands: new Collection<string, unknown>(), cooldowns: new Collection<string, unknown>() },
		replied: config.replied ?? false,
		deferred: config.deferred ?? false,
        isChatInputCommand: vi.fn(() => config.isChatInputCommand ?? true),
        commandName: config.commandName ?? 'mock-command',

		inCachedGuild: vi.fn(() => config.inCachedGuild ?? true),
		inGuild: vi.fn(() => config.inGuild ?? config.inCachedGuild ?? true),

		options: {
			getString: vi.fn((name: string) => options.strings?.[name] ?? null),
			getInteger: vi.fn((name: string) => options.integers?.[name] ?? null),
			getBoolean: vi.fn((name: string) => options.booleans?.[name] ?? null),
			getChannel: vi.fn((name: string) => options.channels?.[name] ?? null),
			getUser: vi.fn((name: string) => options.users?.[name] ?? null),
			getSubcommand: vi.fn(() => options.subcommand ?? ''),
		},

		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	};
}