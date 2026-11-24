import { describe, it, expect, beforeEach } from 'vitest';
import { __resetForTests } from '../../../src/core/database.ts';
import guildDeleteEvent from '../../../src/minecraft/events/guildDelete.ts';
import {
	createBridge,
	getBridgeLinks,
	getGuildBridges,
	getMinecraftGuildSettings,
	getPlayerPictures,
	saveLink,
	setAllowedRole,
	setPlayerPicture,
} from '../../../src/minecraft/storage.ts';

beforeEach(() => {
	__resetForTests();
});

function bridgeIn(guildId: string) {
	return createBridge({
		guildId,
		chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
		alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
		keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
		serverName: 'Survival',
		now: 1000,
	});
}

describe('guildDelete event (Minecraft)', () => {
	it("deletes the server's bridges, pictures, links and settings when the bot leaves it, and no other server's", () => {
		const bridge = bridgeIn('g1');
		setPlayerPicture(bridge.id, 'Steve', 'skin');
		saveLink({
			bridgeId: bridge.id,
			name: 'Steve',
			userId: 'u1',
			uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
			now: 1,
		});
		setAllowedRole('g1', 'role1');
		const other = bridgeIn('g2');

		guildDeleteEvent.execute({ id: 'g1' } as never);

		expect(getGuildBridges('g1')).toEqual([]);
		expect(getPlayerPictures(bridge.id)).toEqual([]);
		expect(getBridgeLinks(bridge.id)).toEqual([]);
		expect(getMinecraftGuildSettings('g1')).toBeUndefined();
		expect(getGuildBridges('g2').map((b) => b.id)).toEqual([other.id]);
	});
});
