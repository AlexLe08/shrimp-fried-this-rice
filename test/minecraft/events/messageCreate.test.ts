import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection, MessageType } from 'discord.js';
import { __resetForTests } from '../../../src/core/database.ts';
import { startDashboard, stopDashboard } from '../../../src/dashboard/server.ts';
import messageCreateEvent from '../../../src/minecraft/events/messageCreate.ts';
import { HelperHub } from '../../../src/minecraft/helperHub.ts';
import { createBridge, markBridgeAnnounced } from '../../../src/minecraft/storage.ts';

beforeEach(() => {
	__resetForTests();
});

afterEach(async () => {
	await stopDashboard();
});

function announcedBridge() {
	const bridge = createBridge({
		guildId: 'g1',
		chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
		alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
		keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
		serverName: 'Survival',
		now: 1000,
	});
	markBridgeAnnounced(bridge.id, 'chat');
	return bridge;
}

const chatMessage = {
	id: '1300000000000000001',
	type: MessageType.Default,
	webhookId: null,
	author: { id: 'u1', bot: false, displayName: 'alex' },
	member: { displayName: 'Alex' },
	guildId: 'g1',
	channelId: 'chat',
	guild: { members: { cache: new Collection() } },
	cleanContent: 'hi',
	attachments: new Collection(),
	stickers: new Collection(),
	mentions: { repliedUser: null },
	inGuild: () => true,
};

describe('messageCreate event (Minecraft relay)', () => {
	it("queues chat on the running dashboard's hub", async () => {
		const bridge = announcedBridge();
		const hub = new HelperHub();
		const deliver = vi.spyOn(hub, 'deliver');
		await startDashboard(0, { auth: null, helpers: hub });

		messageCreateEvent.execute(chatMessage as never);

		expect(deliver).toHaveBeenCalledExactlyOnceWith(bridge.id, { kind: 'chat', name: 'Alex', text: 'hi' });
	});

	it('queues nothing while the dashboard is off, as no helper can poll for it', () => {
		announcedBridge();
		const deliver = vi.spyOn(HelperHub.prototype, 'deliver');

		messageCreateEvent.execute(chatMessage as never);

		expect(deliver).not.toHaveBeenCalled();
		deliver.mockRestore();
	});
});
