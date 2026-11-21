import { vi, type Mock } from 'vitest';
import { Collection } from 'discord.js';

// code only ever calls a handful of specific methods on the client; keep it simple
interface MockClientOptions {
	channels?: Record<string, ReturnType<typeof createMockChannel> | null>;
	users?: Record<string, ReturnType<typeof createMockUser>>;
	guilds?: Record<string, { name: string }>;
}

// What the type guards below promise; the vi.fn()s in createMockChannel fit it.
interface FakeChannelParts {
	send: Mock;
	messages: { fetch: Mock };
}

export function createMockChannel(options: { sendable?: boolean; textBased?: boolean } = {}) {
	return {
		id: 'mock-channel-id',
		// Methods, not vi.fn: the client interfaces declare these as type
		// guards, which a function returning a plain boolean doesn't satisfy.
		isSendable(): this is FakeChannelParts {
			return options.sendable ?? true;
		},
		isTextBased(): this is FakeChannelParts {
			return options.textBased ?? true;
		},
		send: vi.fn().mockResolvedValue({ id: 'mock-message-id', channelId: 'mock-channel-id' }),
		messages: {
			fetch: vi.fn(),
		},
	};
}

// A guild channel: permissionsFor answers `allows` for every permission
// asked, whoever it is asked for.
export function createMockGuildChannel(allows: (permission: bigint) => boolean = () => true) {
	return Object.assign(createMockChannel(), { permissionsFor: vi.fn(() => ({ has: allows })) });
}

export function createMockGuild<C extends { id: string }, R extends { id: string } = { id: string }>(
	options: { channels?: C[]; roles?: R[] } = {},
) {
	return {
		id: 'g1',
		name: 'Test Guild',
		members: { me: {} },
		channels: { cache: new Collection((options.channels ?? []).map((channel) => [channel.id, channel])) },
		roles: { cache: new Collection((options.roles ?? []).map((role) => [role.id, role])) },
	};
}

export function createMockUser(overrides: { sendShouldFail?: boolean } = {}) {
	return {
		id: 'mock-user-id',
		send: overrides.sendShouldFail
			? vi.fn().mockRejectedValue(new Error('Cannot send messages to this user'))
			: vi.fn().mockResolvedValue(undefined),
	};
}

// discord.js's users.fetch and guilds.fetch reject for an unknown id;
// only channels.fetch can resolve null.
function notFound(kind: string, id: string): Promise<never> {
	return Promise.reject(new Error(`mock: no ${kind} ${id}`));
}

export function createMockClient(options: MockClientOptions = {}) {
	return {
		user: 'mock-bot-user-id',
		channels: {
			fetch: vi.fn((id: string) => Promise.resolve(options.channels?.[id] ?? null)),
		},
		users: {
			fetch: vi.fn((id: string) => {
				const user = options.users?.[id];
				return user ? Promise.resolve(user) : notFound('user', id);
			}),
		},
		guilds: {
			fetch: vi.fn((id: string) => {
				const guild = options.guilds?.[id];
				return guild ? Promise.resolve(guild) : notFound('guild', id);
			}),
		},
	};
}
