import { describe, it, expect, beforeEach } from 'vitest';
import { __resetForTests } from '../../../src/core/database.ts';
import guildDeleteEvent from '../../../src/minecraft/events/guildDelete.ts';
import {
	createBridge,
	getGuildBridges,
	getMinecraftGuildSettings,
	setAllowedRole,
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
	it("deletes the server's bridges and settings when the bot leaves it, and no other server's", () => {
		bridgeIn('g1');
		setAllowedRole('g1', 'role1');
		const other = bridgeIn('g2');

		guildDeleteEvent.execute({ id: 'g1' } as never);

		expect(getGuildBridges('g1')).toEqual([]);
		expect(getMinecraftGuildSettings('g1')).toBeUndefined();
		expect(getGuildBridges('g2').map((b) => b.id)).toEqual([other.id]);
	});
});
