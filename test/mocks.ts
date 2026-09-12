import { vi } from 'vitest';

// code only ever calls a handful of specific methods on the client; keep it simple
interface MockClientOptions {
	channels?: Record<string, ReturnType<typeof createMockChannel> | null>;
	users?: Record<string, ReturnType<typeof createMockUser> | null>;
	guilds?: Record<string, { name: string } | null>;
}

export function createMockChannel(options: { sendable?: boolean; textBased?: boolean } = {}) {
	return {
		id: 'mock-channel-id',
		isSendable: vi.fn(() => options.sendable ?? true),
		isTextBased: vi.fn(() => options.textBased ?? true),
		send: vi.fn().mockResolvedValue({ id: 'mock-message-id', channelId: 'mock-channel-id' }),
		messages: {
			fetch: vi.fn(),
		},
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

export function createMockClient(options: MockClientOptions = {}) {
	return {
		channels: {
			fetch: vi.fn((id: string) => Promise.resolve(options.channels?.[id] ?? null)),
		},
		users: {
			fetch: vi.fn((id: string) => Promise.resolve(options.users?.[id] ?? null)),
		},
		guilds: {
			fetch: vi.fn((id: string) => Promise.resolve(options.guilds?.[id] ?? null)),
		},
	};
}