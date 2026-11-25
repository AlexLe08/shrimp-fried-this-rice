import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection, MessageType, SnowflakeUtil, type Message } from 'discord.js';
import { __resetForTests } from '../../src/core/database.ts';
import {
	CATCH_UP_HOLD_MS,
	CATCH_UP_MAX_AGE_MS,
	CATCH_UP_MAX_MESSAGES,
	catchUpBridges,
	type CatchUpClient,
} from '../../src/minecraft/catchUp.ts';
import type { HelperHub } from '../../src/minecraft/helperHub.ts';
import { relayMessage } from '../../src/minecraft/relay.ts';
import {
	createBridge,
	getBridge,
	getBridgesToCatchUp,
	markBridgeAnnounced,
	recordRelayedMessage,
} from '../../src/minecraft/storage.ts';

const NOW = 1_790_000_000_000;

beforeEach(() => {
	__resetForTests();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A message id from `secondsAgo` before NOW, unique per call. */
let sequence = 0;
function idAt(secondsAgo: number): string {
	sequence += 1;
	return SnowflakeUtil.generate({ timestamp: NOW - secondsAgo * 1000, increment: BigInt(sequence % 4096) }).toString();
}

function message(id: string, overrides: Record<string, unknown> = {}): Message<true> {
	return {
		id,
		type: MessageType.Default,
		webhookId: null,
		author: { id: 'u1', bot: false, system: false, displayName: 'alex' },
		member: { displayName: 'Alex' },
		guildId: 'g1',
		channelId: 'chat',
		guild: { members: { cache: new Collection() } },
		cleanContent: `text ${id}`,
		attachments: new Collection(),
		stickers: new Collection(),
		mentions: { repliedUser: null },
		inGuild: () => true,
		...overrides,
	} as unknown as Message<true>;
}

function relayingBridge(lastRelayed: string | null) {
	const bridge = createBridge({
		guildId: 'g1',
		chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
		alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
		keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
		serverName: 'Survival',
		now: 1000,
	});
	markBridgeAnnounced(bridge.id, 'chat');
	if (lastRelayed) recordRelayedMessage(bridge.id, lastRelayed);
	return bridge;
}

function fakeHub() {
	const deliver = vi.fn<HelperHub['deliver']>(() => true);
	const hub = { deliver, closed: false };
	return { hub: hub as unknown as HelperHub & { closed: boolean }, deliver };
}

/** A client whose chat channel answers with `messages`, or whose fetch waits on `gate`. */
function fakeClient(messages: Message<true>[], gate?: Promise<void>) {
	const fetchMessages = vi.fn<(options: { after: string; limit: number; cache: boolean }) => Promise<unknown>>(
		async () => {
			await gate;
			// Newest first, as Discord's docs say.
			return new Collection([...messages].reverse().map((m) => [m.id, m]));
		},
	);
	const channel = { isTextBased: () => true, isDMBased: () => false, messages: { fetch: fetchMessages } };
	const client = { channels: { fetch: vi.fn(async () => channel) } };
	return { client: client as unknown as CatchUpClient, fetchMessages };
}

const texts = (deliver: ReturnType<typeof fakeHub>['deliver']) =>
	deliver.mock.calls.map((call) => (call[1] as { text: string }).text);

describe('catching up after a restart', () => {
	it('relays what was missed since the last relayed message, oldest first, held 2 minutes, and records it', async () => {
		const last = idAt(60);
		const bridge = relayingBridge(last);
		const missed = [idAt(50), idAt(40), idAt(30)];
		const { client, fetchMessages } = fakeClient(missed.map((id) => message(id)));
		const { hub, deliver } = fakeHub();

		await catchUpBridges(client, hub, NOW);

		expect(fetchMessages).toHaveBeenCalledExactlyOnceWith({ after: last, limit: 100, cache: false });
		expect(texts(deliver)).toEqual(missed.map((id) => `text ${id}`));
		expect(deliver.mock.calls.every((call) => call[2] === CATCH_UP_HOLD_MS)).toBe(true);
		expect(getBridge(bridge.id)?.last_relayed_message_id).toBe(missed[2]);
	});

	it(`asks only for the last ${CATCH_UP_MAX_AGE_MS / 60_000} minutes when the last relayed message is older`, async () => {
		relayingBridge(idAt(3600));
		const recent = idAt(10);
		const { client, fetchMessages } = fakeClient([message(recent)]);
		const { hub, deliver } = fakeHub();

		await catchUpBridges(client, hub, NOW);

		const after = fetchMessages.mock.calls[0]![0].after;
		expect(SnowflakeUtil.timestampFrom(after)).toBe(NOW - CATCH_UP_MAX_AGE_MS);
		expect(texts(deliver)).toEqual([`text ${recent}`]);
	});

	it(`relays at most ${CATCH_UP_MAX_MESSAGES} members' messages, the oldest, skipping webhooks and apps`, async () => {
		relayingBridge(idAt(200));
		const posts = [message(idAt(150), { webhookId: 'wh-chat' }), message(idAt(149), { author: { bot: true } })];
		const members = Array.from({ length: CATCH_UP_MAX_MESSAGES + 5 }, (_, i) => message(idAt(140 - i)));
		const { client } = fakeClient([...posts, ...members]);
		const { hub, deliver } = fakeHub();

		await catchUpBridges(client, hub, NOW);

		expect(texts(deliver)).toEqual(members.slice(0, CATCH_UP_MAX_MESSAGES).map((m) => `text ${m.id}`));
	});

	it('holds live messages meanwhile, stops before the first of them, then relays them after, without repeats', async () => {
		const bridge = relayingBridge(idAt(100));
		const missed = message(idAt(90));
		const firstLive = message(idAt(1));
		const secondLive = message(idAt(0));
		let open!: () => void;
		// Discord's answer includes the first live message too, sent while it was asked.
		const { client } = fakeClient([missed, firstLive], new Promise((resolve) => (open = resolve)));
		const { hub, deliver } = fakeHub();

		const catchingUp = catchUpBridges(client, hub, NOW);
		relayMessage(firstLive, hub);
		relayMessage(secondLive, hub);
		expect(deliver).not.toHaveBeenCalled();
		open();
		await catchingUp;

		expect(texts(deliver)).toEqual([missed.id, firstLive.id, secondLive.id].map((id) => `text ${id}`));
		expect(getBridge(bridge.id)?.last_relayed_message_id).toBe(secondLive.id);
		// The gateway bringing one the catch-up already relayed sends it no further.
		relayMessage(missed, hub);
		expect(deliver).toHaveBeenCalledTimes(3);
	});

	it('logs a failed fetch, without its URL, and still lets live messages through', async () => {
		relayingBridge(idAt(100));
		const { client, fetchMessages } = fakeClient([]);
		fetchMessages.mockRejectedValue(
			Object.assign(new Error('Missing Access'), { status: 403, code: 50001, url: 'https://discord.com/x' }),
		);
		const { hub, deliver } = fakeHub();

		const catchingUp = catchUpBridges(client, hub, NOW);
		const live = message(idAt(0));
		relayMessage(live, hub);
		await catchingUp;

		expect(texts(deliver)).toEqual([`text ${live.id}`]);
		const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
		expect(logged).toContain('403 50001 Missing Access');
		expect(logged).not.toContain('discord.com');
	});

	it('records and relays nothing once shutdown closed the hub during the fetch', async () => {
		const last = idAt(100);
		const bridge = relayingBridge(last);
		let open!: () => void;
		const { client } = fakeClient([message(idAt(50))], new Promise((resolve) => (open = resolve)));
		const { hub, deliver } = fakeHub();

		const catchingUp = catchUpBridges(client, hub, NOW);
		relayMessage(message(idAt(0)), hub);
		hub.closed = true;
		open();
		await catchingUp;

		expect(deliver).not.toHaveBeenCalled();
		expect(getBridge(bridge.id)?.last_relayed_message_id).toBe(last);
	});

	it('does nothing without the dashboard’s hub, or for a channel that’s gone', async () => {
		relayingBridge(idAt(100));
		const { client, fetchMessages } = fakeClient([message(idAt(50))]);
		await catchUpBridges(client, null, NOW);
		expect(fetchMessages).not.toHaveBeenCalled();

		const gone = { channels: { fetch: vi.fn(async () => null) } } as unknown as CatchUpClient;
		const { hub, deliver } = fakeHub();
		await catchUpBridges(gone, hub, NOW);
		expect(deliver).not.toHaveBeenCalled();
	});

	it('catches up only bridges relaying in their chat channel that have relayed before', () => {
		const relaying = relayingBridge(idAt(100));
		relayingBridge(null);
		const moved = relayingBridge(idAt(100));
		markBridgeAnnounced(moved.id, 'old-chat');

		expect(getBridgesToCatchUp().map((bridge) => bridge.id)).toEqual([relaying.id]);
	});
});
