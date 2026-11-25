import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection, MessageType, type Message } from 'discord.js';
import { __resetForTests } from '../../src/core/database.ts';
import type { HelperHub } from '../../src/minecraft/helperHub.ts';
import { RELAYED_PER_SECOND, relayMessage } from '../../src/minecraft/relay.ts';
import { createBridge, getBridge, markBridgeAnnounced } from '../../src/minecraft/storage.ts';

beforeEach(() => {
	__resetForTests();
	// The relay's rate limit runs on Date.now, so each test starts in a new second.
	vi.useFakeTimers();
	vi.setSystemTime(Date.now() + 10_000);
});

afterEach(() => {
	vi.useRealTimers();
});

function bridgeIn(guildId: string, chatChannelId = 'chat', announced: string | null = chatChannelId) {
	const bridge = createBridge({
		guildId,
		chat: { channelId: chatChannelId, webhookId: 'wh-chat', token: 'tok-chat' },
		alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
		keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
		serverName: 'Survival',
		now: 1000,
	});
	if (announced) markBridgeAnnounced(bridge.id, announced);
	return bridge;
}

function fakeHub(accepts = true) {
	const deliver = vi.fn<HelperHub['deliver']>(() => accepts);
	return { hub: { deliver } as unknown as HelperHub, deliver };
}

type FakeMessage = Record<string, unknown>;

let nextId = 1_300_000_000_000_000_000n;

function message(overrides: FakeMessage = {}): Message {
	nextId += 1n;
	return {
		id: String(nextId),
		type: MessageType.Default,
		webhookId: null,
		author: { id: 'u1', bot: false, displayName: 'alex_global' },
		member: { displayName: 'Alex' },
		guildId: 'g1',
		channelId: 'chat',
		guild: { members: { cache: new Collection([['u2', { displayName: 'Sam (nick)' }]]) } },
		cleanContent: 'hello @Sam #general :wave:',
		attachments: new Collection(),
		stickers: new Collection(),
		mentions: { repliedUser: null },
		inGuild: () => true,
		...overrides,
	} as unknown as Message;
}

describe('relayMessage', () => {
	it("queues a member's message in the announced chat channel, under their server nickname, and records it", () => {
		const bridge = bridgeIn('g1');
		const { hub, deliver } = fakeHub();
		const sent = message();

		relayMessage(sent, hub);

		expect(deliver).toHaveBeenCalledExactlyOnceWith(bridge.id, {
			kind: 'chat',
			name: 'Alex',
			text: 'hello @Sam #general :wave:',
		});
		expect(getBridge(bridge.id)?.last_relayed_message_id).toBe(sent.id);
	});

	it('uses the display name when the sender has no member (a nickname of their own is the member’s)', () => {
		bridgeIn('g1');
		const { hub, deliver } = fakeHub();

		relayMessage(message({ member: null }), hub);

		expect(deliver.mock.calls[0]?.[1]).toMatchObject({ name: 'alex_global' });
	});

	it('relays nothing before the announcement, or after the chat moved to a channel not yet announced', () => {
		bridgeIn('g1', 'chat', null);
		bridgeIn('g1', 'chat', 'old-chat');
		const { hub, deliver } = fakeHub();

		relayMessage(message(), hub);

		expect(deliver).not.toHaveBeenCalled();
	});

	it('ignores other channels, other servers and direct messages', () => {
		bridgeIn('g1');
		const { hub, deliver } = fakeHub();

		relayMessage(message({ channelId: 'general' }), hub);
		relayMessage(message({ guildId: 'g2' }), hub);
		relayMessage(message({ inGuild: () => false }), hub);

		expect(deliver).not.toHaveBeenCalled();
	});

	it("skips webhooks (the bridge's own game chat), apps, Discord's messages and slash command replies", () => {
		bridgeIn('g1');
		const { hub, deliver } = fakeHub();

		relayMessage(message({ webhookId: 'wh-chat' }), hub);
		relayMessage(message({ author: { id: 'app', bot: true, displayName: 'App' } }), hub);
		relayMessage(message({ type: MessageType.ChannelPinnedMessage }), hub);
		relayMessage(message({ type: MessageType.UserJoin }), hub);
		relayMessage(message({ type: MessageType.ChatInputCommand }), hub);

		expect(deliver).not.toHaveBeenCalled();
	});

	it('shows attachments and stickers as [image], [file] and [sticker], with or without text', () => {
		bridgeIn('g1');
		const { hub, deliver } = fakeHub();
		const attachments = new Collection([
			['a1', { contentType: 'image/png' }],
			['a2', { contentType: 'application/pdf' }],
			['a3', { contentType: null }],
		]);

		relayMessage(message({ cleanContent: 'look', attachments }), hub);
		relayMessage(message({ cleanContent: '', stickers: new Collection([['s1', {}]]) }), hub);

		expect(deliver.mock.calls.map((call) => (call[1] as { text: string }).text)).toEqual([
			'look [image] [file] [file]',
			'[sticker]',
		]);
	});

	it('names who a reply answers: their nickname if cached, else their name (a relayed game message’s player)', () => {
		bridgeIn('g1');
		const { hub, deliver } = fakeHub();

		relayMessage(
			message({ type: MessageType.Reply, mentions: { repliedUser: { id: 'u2', displayName: 'sam' } } }),
			hub,
		);
		relayMessage(
			message({ type: MessageType.Reply, mentions: { repliedUser: { id: 'webhook', displayName: 'Steve' } } }),
			hub,
		);
		// The message replied to was deleted: no author to name.
		relayMessage(message({ type: MessageType.Reply }), hub);

		expect(deliver.mock.calls.map((call) => (call[1] as { text: string }).text)).toEqual([
			'(reply to Sam (nick)) hello @Sam #general :wave:',
			'(reply to Steve) hello @Sam #general :wave:',
			'hello @Sam #general :wave:',
		]);
	});

	it('relays nothing for a message with nothing to show (a poll, a forward), even as a reply', () => {
		const bridge = bridgeIn('g1');
		const { hub, deliver } = fakeHub();

		relayMessage(message({ cleanContent: '' }), hub);
		relayMessage(
			message({
				cleanContent: '',
				type: MessageType.Reply,
				mentions: { repliedUser: { id: 'u2', displayName: 'sam' } },
			}),
			hub,
		);

		expect(deliver).not.toHaveBeenCalled();
		expect(getBridge(bridge.id)?.last_relayed_message_id).toBeNull();
	});

	it(`drops messages past ${RELAYED_PER_SECOND} a second per bridge, and takes them again the next second`, () => {
		const busy = bridgeIn('g1');
		const quiet = bridgeIn('g2');
		const { hub, deliver } = fakeHub();

		for (let i = 0; i < RELAYED_PER_SECOND + 2; i++) relayMessage(message(), hub);
		relayMessage(message({ guildId: 'g2' }), hub);
		expect(deliver.mock.calls.filter((call) => call[0] === busy.id)).toHaveLength(RELAYED_PER_SECOND);
		expect(deliver.mock.calls.filter((call) => call[0] === quiet.id)).toHaveLength(1);

		vi.advanceTimersByTime(1000);
		relayMessage(message(), hub);
		expect(deliver.mock.calls.filter((call) => call[0] === busy.id)).toHaveLength(RELAYED_PER_SECOND + 1);
	});

	it('records nothing when the hub drops the message (too many waiting)', () => {
		const bridge = bridgeIn('g1');
		const { hub, deliver } = fakeHub(false);

		relayMessage(message(), hub);

		expect(deliver).toHaveBeenCalledOnce();
		expect(getBridge(bridge.id)?.last_relayed_message_id).toBeNull();
	});

	it('queues the message for each bridge sharing the channel', () => {
		const first = bridgeIn('g1');
		const second = bridgeIn('g1');
		const { hub, deliver } = fakeHub();
		const sent = message();

		relayMessage(sent, hub);

		expect(deliver.mock.calls.map((call) => call[0]).sort()).toEqual([first.id, second.id].sort());
		expect(getBridge(first.id)?.last_relayed_message_id).toBe(sent.id);
		expect(getBridge(second.id)?.last_relayed_message_id).toBe(sent.id);
	});
});
