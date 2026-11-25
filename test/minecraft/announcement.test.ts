import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTJSONErrorCodes, WebhookClient } from 'discord.js';
import { __resetForTests } from '../../src/core/database.ts';
import {
	ANNOUNCEMENT_RETRY_MS,
	announcementText,
	createAnnouncer,
	postWithWebhook,
	type AnnouncementPost,
} from '../../src/minecraft/announcement.ts';
import {
	createBridge,
	getBridge,
	markBridgeAnnounced,
	replaceBridgeConnection,
	type MinecraftBridge,
} from '../../src/minecraft/storage.ts';

let time = 1_790_000_000_000;
const now = () => time;

beforeEach(() => {
	__resetForTests();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function paired(): MinecraftBridge {
	return createBridge({
		guildId: 'g1',
		chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
		alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
		keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
		serverName: 'Survival',
		now: 1000,
	});
}

const fresh = (bridge: MinecraftBridge) => getBridge(bridge.id)!;

// The id Discord gives the posted announcement.
const POSTED = '1400000000000000000';

function discordError(code: number) {
	return Object.assign(new Error('refused'), { code });
}

describe('the relay announcement', () => {
	it("posts through the chat webhook under the server's name, then records the channel", async () => {
		const post = vi.fn<(post: AnnouncementPost) => Promise<string>>(() => Promise.resolve(POSTED));
		const bridge = paired();

		await createAnnouncer({ post, now }).ensure(bridge);

		expect(post).toHaveBeenCalledExactlyOnceWith({
			webhook: { id: 'wh-chat', token: 'tok-chat' },
			username: 'Survival',
			content: announcementText('Survival'),
		});
		expect(fresh(bridge).announced_channel_id).toBe('chat');
		// So a catch-up after a restart starts no earlier than the announcement.
		expect(fresh(bridge).last_relayed_message_id).toBe(POSTED);
	});

	it('posts nothing once announced in the chat channel, and again once the chat has moved', async () => {
		const post = vi.fn(() => Promise.resolve(POSTED));
		const announcer = createAnnouncer({ post, now });
		const bridge = paired();
		markBridgeAnnounced(bridge.id, 'chat');
		await announcer.ensure(fresh(bridge));
		expect(post).not.toHaveBeenCalled();

		markBridgeAnnounced(bridge.id, 'old-chat');
		await announcer.ensure(fresh(bridge));
		expect(post).toHaveBeenCalledOnce();
		expect(fresh(bridge).announced_channel_id).toBe('chat');
	});

	it('posts once when two requests ask at the same time', async () => {
		let finish!: () => void;
		const post = vi.fn(() => new Promise<string>((resolve) => (finish = () => resolve(POSTED))));
		const announcer = createAnnouncer({ post, now });
		const bridge = paired();

		const first = announcer.ensure(bridge);
		await announcer.ensure(bridge);
		finish();
		await first;

		expect(post).toHaveBeenCalledOnce();
	});

	it(`tries a refused post again only after ${ANNOUNCEMENT_RETRY_MS / 60_000} minutes`, async () => {
		const post = vi.fn().mockRejectedValueOnce(discordError(500)).mockResolvedValue(POSTED);
		const announcer = createAnnouncer({ post, now });
		const bridge = paired();

		await announcer.ensure(bridge);
		expect(fresh(bridge).announced_channel_id).toBeNull();
		time += ANNOUNCEMENT_RETRY_MS - 1;
		await announcer.ensure(bridge);
		expect(post).toHaveBeenCalledOnce();

		time += 1;
		await announcer.ensure(bridge);
		expect(post).toHaveBeenCalledTimes(2);
		expect(fresh(bridge).announced_channel_id).toBe('chat');
	});

	it('stops trying a webhook Discord says is gone, until regenerating replaces it', async () => {
		const post = vi.fn().mockRejectedValueOnce(discordError(RESTJSONErrorCodes.UnknownWebhook));
		const announcer = createAnnouncer({ post, now });
		const bridge = paired();

		await announcer.ensure(bridge);
		time += ANNOUNCEMENT_RETRY_MS * 10;
		await announcer.ensure(bridge);
		expect(post).toHaveBeenCalledOnce();

		post.mockResolvedValue(POSTED);
		replaceBridgeConnection(bridge.id, {
			chat: { channelId: 'chat', webhookId: 'wh-chat-2', token: 'tok-chat-2' },
			alerts: { channelId: 'alerts', webhookId: 'wh-alerts-2', token: 'tok-alerts-2' },
			keys: { request: Buffer.alloc(32, 3), response: Buffer.alloc(32, 4) },
		});
		await announcer.ensure(fresh(bridge));
		expect(post).toHaveBeenCalledTimes(2);
		expect(fresh(bridge).announced_channel_id).toBe('chat');
	});

	it('records nothing for a post that finishes after shutdown began, and posts nothing after it', async () => {
		let finish!: () => void;
		const post = vi.fn(() => new Promise<string>((resolve) => (finish = () => resolve(POSTED))));
		const announcer = createAnnouncer({ post, now });
		const bridge = paired();

		const posting = announcer.ensure(bridge);
		announcer.close();
		finish();
		await posting;
		await announcer.ensure(bridge);

		expect(fresh(bridge).announced_channel_id).toBeNull();
		expect(post).toHaveBeenCalledOnce();
	});

	it('records nothing if the chat moved while posting, and then announces in the new channel', async () => {
		let finish!: () => void;
		const post = vi.fn<(post: AnnouncementPost) => Promise<string>>(
			() => new Promise<string>((resolve) => (finish = () => resolve(POSTED))),
		);
		const announcer = createAnnouncer({ post, now });
		const bridge = paired();

		const posting = announcer.ensure(bridge);
		replaceBridgeConnection(bridge.id, { chat: { channelId: 'new-chat', webhookId: 'wh-new', token: 'tok-new' } });
		finish();
		await posting;
		expect(fresh(bridge).announced_channel_id).toBeNull();

		const again = announcer.ensure(fresh(bridge));
		finish();
		await again;
		expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ webhook: { id: 'wh-new', token: 'tok-new' } }));
		expect(fresh(bridge).announced_channel_id).toBe('new-chat');
	});

	it("never logs the webhook's token, which a REST error's URL carries", async () => {
		const refused = Object.assign(new Error('Internal Server Error'), {
			status: 500,
			url: 'https://discord.com/api/v10/webhooks/wh-chat/tok-chat',
			requestBody: { json: { content: 'x' } },
		});
		const announcer = createAnnouncer({ post: vi.fn().mockRejectedValue(refused), now });

		await announcer.ensure(paired());

		const logged = vi
			.mocked(console.error)
			.mock.calls.flat()
			.map((arg) => inspect(arg))
			.join('\n');
		expect(logged).toContain('500 Internal Server Error');
		expect(logged).not.toContain('tok-chat');
	});

	it("names the server in bold, its Markdown escaped, as it's the server owner's text", () => {
		const text = announcementText('Sur_vival *2*');
		expect(text).toContain('**Sur\\_vival \\*2\\***');
		expect(text).toMatch(/^Messages posted in this channel now also show in game on /);
	});

	it('sends with the webhook’s token and allows no mention to ping', async () => {
		const send = vi.spyOn(WebhookClient.prototype, 'send').mockResolvedValue({ id: POSTED } as never);
		const destroy = vi.spyOn(WebhookClient.prototype, 'destroy');

		await expect(
			postWithWebhook({ webhook: { id: '123', token: 'tok' }, username: 'Survival', content: '@everyone hi' }),
		).resolves.toBe(POSTED);

		expect(send).toHaveBeenCalledExactlyOnceWith({
			content: '@everyone hi',
			username: 'Survival',
			allowedMentions: { parse: [] },
		});
		expect(destroy).toHaveBeenCalledOnce();
	});
});
