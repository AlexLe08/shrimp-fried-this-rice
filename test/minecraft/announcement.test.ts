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
	deleteGuildMinecraftData,
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

function discordError(code: number) {
	return Object.assign(new Error('refused'), { code });
}

describe('the relay announcement', () => {
	it("posts through the chat webhook under the server's name, then records the channel", async () => {
		const post = vi.fn<(post: AnnouncementPost) => Promise<void>>(() => Promise.resolve());
		const bridge = paired();

		await createAnnouncer({ post, now }).ensure(bridge);

		expect(post).toHaveBeenCalledExactlyOnceWith({
			webhook: { id: 'wh-chat', token: 'tok-chat' },
			username: 'Survival',
			content: announcementText('Survival'),
		});
		expect(fresh(bridge).announced_channel_id).toBe('chat');
	});

	it('posts nothing once announced in the chat channel, and again once the chat has moved', async () => {
		const post = vi.fn(() => Promise.resolve());
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
		const post = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		const announcer = createAnnouncer({ post, now });
		const bridge = paired();

		const first = announcer.ensure(bridge);
		await announcer.ensure(bridge);
		finish();
		await first;

		expect(post).toHaveBeenCalledOnce();
	});

	it(`tries a refused post again only after ${ANNOUNCEMENT_RETRY_MS / 60_000} minutes`, async () => {
		const post = vi.fn().mockRejectedValueOnce(discordError(500)).mockResolvedValue(undefined);
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

		post.mockResolvedValue(undefined);
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
		const post = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
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

	it('records nothing if the bridge was removed while posting', async () => {
		let finish!: () => void;
		const post = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		const bridge = paired();

		const posting = createAnnouncer({ post, now }).ensure(bridge);
		deleteGuildMinecraftData(bridge.guild_id);
		finish();
		await posting;

		expect(getBridge(bridge.id)).toBeUndefined();
	});

	it("names the server in bold, its Markdown escaped, as it's the server owner's text", () => {
		const text = announcementText('Sur_vival *2*');
		expect(text).toContain('**Sur\\_vival \\*2\\***');
		expect(text).toMatch(/^Messages posted in this channel now also show in game on /);
	});

	it('sends with the webhook’s token and allows no mention to ping', async () => {
		const send = vi.spyOn(WebhookClient.prototype, 'send').mockResolvedValue({} as never);
		const destroy = vi.spyOn(WebhookClient.prototype, 'destroy');

		await postWithWebhook({ webhook: { id: '123', token: 'tok' }, username: 'Survival', content: '@everyone hi' });

		expect(send).toHaveBeenCalledExactlyOnceWith({
			content: '@everyone hi',
			username: 'Survival',
			allowedMentions: { parse: [] },
		});
		expect(destroy).toHaveBeenCalledOnce();
	});
});
