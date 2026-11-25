import { describe, it, expect, beforeEach } from 'vitest';
import { __resetForTests, db } from '../../src/core/database.ts';
import {
	createBridge,
	deleteBridge,
	deleteGuildMinecraftData,
	deleteLink,
	deleteMemberLinks,
	getBridge,
	getBridgeLinks,
	getGuildBridges,
	getLink,
	getMemberLinks,
	getMinecraftGuildSettings,
	MAX_PICTURES_PER_BRIDGE,
	getPlayerPictures,
	markBridgeAnnounced,
	recordRelayedMessage,
	replaceBridgeConnection,
	saveLink,
	setAllowedRole,
	setLinkPicture,
	setPlayerPicture,
	updateBridgeSettings,
	type BridgeKeys,
} from '../../src/minecraft/storage.ts';

beforeEach(() => {
	__resetForTests();
});

const STEVE_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const ALEX_UUID = '853c80ef-3c37-49fd-aa49-938b674adae6';

function keys(fill: number): BridgeKeys {
	return { request: Buffer.alloc(32, fill), response: Buffer.alloc(32, fill + 1) };
}

function newBridge(guildId = 'g1', now = 1000) {
	return createBridge({
		guildId,
		chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
		alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
		keys: keys(1),
		serverName: 'Survival',
		now,
	});
}

function count(table: string): number {
	return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('minecraft bridge storage', () => {
	it('saves a new bridge with the default prefix, colour and pictures, and its keys as given', () => {
		const bridge = newBridge();

		expect(bridge).toMatchObject({
			guild_id: 'g1',
			chat_channel_id: 'chat',
			chat_webhook_id: 'wh-chat',
			chat_webhook_token: 'tok-chat',
			alerts_channel_id: 'alerts',
			alerts_webhook_id: 'wh-alerts',
			alerts_webhook_token: 'tok-alerts',
			server_name: 'Survival',
			prefix: '[Discord]',
			colour: '#5865F2',
			default_picture: null,
			announced_channel_id: null,
			last_relayed_message_id: null,
			created_at: 1000,
		});
		expect(bridge.request_key.equals(keys(1).request)).toBe(true);
		expect(bridge.response_key.equals(keys(1).response)).toBe(true);
		expect(getBridge(bridge.id)).toEqual(bridge);
	});

	// The id travels in the clear and keys the per-bridge rate limit.
	it('gives each bridge a random 128-bit id', () => {
		const ids = [newBridge().id, newBridge().id];

		for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("lists a server's bridges oldest first, and only that server's", () => {
		const first = newBridge('g1', 1000);
		const second = newBridge('g1', 2000);
		newBridge('g2', 500);

		expect(getGuildBridges('g1').map((b) => b.id)).toEqual([first.id, second.id]);
		expect(getGuildBridges('g3')).toEqual([]);
	});

	it('changes only the settings given, and can hand the default picture back to the config', () => {
		const bridge = newBridge();

		expect(updateBridgeSettings(bridge.id, { prefix: '[DC]', defaultPicture: 'skin' })).toMatchObject({
			server_name: 'Survival',
			prefix: '[DC]',
			colour: '#5865F2',
			default_picture: 'skin',
		});
		expect(updateBridgeSettings(bridge.id, { serverName: 'Creative', colour: 'gold' })).toMatchObject({
			server_name: 'Creative',
			prefix: '[DC]',
			colour: 'gold',
			default_picture: 'skin',
		});
		expect(updateBridgeSettings(bridge.id, { defaultPicture: null })?.default_picture).toBeNull();
		expect(updateBridgeSettings('gone', { prefix: '[DC]' })).toBeUndefined();
	});

	it('replaces webhooks and keys together when regenerating, and only what is given otherwise', () => {
		const bridge = newBridge();

		expect(
			replaceBridgeConnection(bridge.id, {
				chat: { channelId: 'chat', webhookId: 'wh-chat-2', token: 'tok-chat-2' },
				alerts: { channelId: 'alerts', webhookId: 'wh-alerts-2', token: 'tok-alerts-2' },
				keys: keys(7),
			}),
		).toBe(true);
		const regenerated = getBridge(bridge.id)!;
		expect(regenerated).toMatchObject({ chat_webhook_token: 'tok-chat-2', alerts_webhook_token: 'tok-alerts-2' });
		expect(regenerated.request_key.equals(keys(7).request)).toBe(true);
		expect(regenerated.response_key.equals(keys(7).response)).toBe(true);

		replaceBridgeConnection(bridge.id, { alerts: { channelId: 'other', webhookId: 'wh-3', token: 'tok-3' } });
		const moved = getBridge(bridge.id)!;
		expect(moved).toMatchObject({
			chat_webhook_token: 'tok-chat-2',
			alerts_channel_id: 'other',
			alerts_webhook_id: 'wh-3',
			alerts_webhook_token: 'tok-3',
		});
		expect(moved.request_key.equals(keys(7).request)).toBe(true);

		expect(replaceBridgeConnection('gone', { keys: keys(9) })).toBe(false);
	});

	it('records the channel the announcement was posted in', () => {
		const bridge = newBridge();

		markBridgeAnnounced(bridge.id, 'chat');

		expect(getBridge(bridge.id)?.announced_channel_id).toBe('chat');
	});

	describe('the last relayed message', () => {
		it('moves forward only, comparing ids as snowflakes', () => {
			const bridge = newBridge();
			const last = () => getBridge(bridge.id)?.last_relayed_message_id;

			recordRelayedMessage(bridge.id, '1300000000000000000');
			expect(last()).toBe('1300000000000000000');

			recordRelayedMessage(bridge.id, '1299999999999999999');
			expect(last()).toBe('1300000000000000000');

			// As text, "999…" (18 digits) sorts after "13…" but is the older id.
			recordRelayedMessage(bridge.id, '999999999999999999');
			expect(last()).toBe('1300000000000000000');

			recordRelayedMessage(bridge.id, '1300000000000000001');
			expect(last()).toBe('1300000000000000001');

			recordRelayedMessage(bridge.id, '10000000000000000000');
			expect(last()).toBe('10000000000000000000');
		});
	});

	describe('who may manage bridges', () => {
		it('has no settings until a role is set, and can clear it', () => {
			expect(getMinecraftGuildSettings('g1')).toBeUndefined();

			setAllowedRole('g1', 'role1');
			expect(getMinecraftGuildSettings('g1')).toEqual({ guild_id: 'g1', allowed_role_id: 'role1' });

			setAllowedRole('g1', null);
			expect(getMinecraftGuildSettings('g1')).toEqual({ guild_id: 'g1', allowed_role_id: null });
		});
	});

	describe("pictures set by a bridge's managers", () => {
		it('keeps one per name whatever its case, and null removes it', () => {
			const bridge = newBridge();

			setPlayerPicture(bridge.id, 'Steve', 'skin');
			setPlayerPicture(bridge.id, 'alex', 'generated:3');
			setPlayerPicture(bridge.id, 'STEVE', 'none');

			expect(getPlayerPictures(bridge.id)).toEqual([
				{ bridge_id: bridge.id, name: 'alex', name_key: 'alex', picture: 'generated:3' },
				{ bridge_id: bridge.id, name: 'STEVE', name_key: 'steve', picture: 'none' },
			]);

			setPlayerPicture(bridge.id, 'steve', null);
			expect(getPlayerPictures(bridge.id).map((p) => p.name_key)).toEqual(['alex']);
		});

		it('refuses a new name once the bridge has the most, but still changes or removes one it has', () => {
			const bridge = newBridge();
			const other = newBridge();
			for (let i = 0; i < MAX_PICTURES_PER_BRIDGE; i++) {
				expect(setPlayerPicture(bridge.id, `player${i}`, 'skin')).toBe(true);
			}

			expect(setPlayerPicture(bridge.id, 'Steve', 'skin')).toBe(false);
			expect(getPlayerPictures(bridge.id).some((p) => p.name_key === 'steve')).toBe(false);
			expect(setPlayerPicture(bridge.id, 'PLAYER0', 'none')).toBe(true);
			expect(getPlayerPictures(bridge.id).find((p) => p.name_key === 'player0')?.picture).toBe('none');
			expect(setPlayerPicture(other.id, 'Steve', 'skin')).toBe(true);

			expect(setPlayerPicture(bridge.id, 'player1', null)).toBe(true);
			expect(setPlayerPicture(bridge.id, 'Steve', 'skin')).toBe(true);
			expect(getPlayerPictures(bridge.id)).toHaveLength(MAX_PICTURES_PER_BRIDGE);
		});
	});

	describe('links', () => {
		it('saves a link with the default picture, found by name whatever its case', () => {
			const bridge = newBridge();

			const link = saveLink({ bridgeId: bridge.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 5000 });

			expect(link).toEqual({
				bridge_id: bridge.id,
				name: 'Steve',
				name_key: 'steve',
				user_id: 'u1',
				uuid: STEVE_UUID,
				picture: 'default',
				linked_at: 5000,
			});
			expect(getLink(bridge.id, 'STEVE')).toEqual(link);
		});

		it('keeps the picture when the same member links the same account again', () => {
			const bridge = newBridge();
			saveLink({ bridgeId: bridge.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 5000 });
			setLinkPicture(bridge.id, 'Steve', 'u1', 'discord');

			const again = saveLink({ bridgeId: bridge.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 6000 });

			expect(again).toMatchObject({ picture: 'discord', linked_at: 6000 });
		});

		// One player's choice never passes to someone else.
		it("replaces a name's link, resetting its picture, when another member or account links it", () => {
			const bridge = newBridge();
			saveLink({ bridgeId: bridge.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 5000 });
			setLinkPicture(bridge.id, 'Steve', 'u1', 'discord');

			const byOther = saveLink({ bridgeId: bridge.id, name: 'steve', userId: 'u2', uuid: STEVE_UUID, now: 6000 });
			expect(byOther).toMatchObject({ name: 'steve', user_id: 'u2', picture: 'default' });

			setLinkPicture(bridge.id, 'Steve', 'u2', 'skin');
			// The name changed hands: same member, another account.
			const newAccount = saveLink({ bridgeId: bridge.id, name: 'Steve', userId: 'u2', uuid: ALEX_UUID, now: 7000 });
			expect(newAccount).toMatchObject({ uuid: ALEX_UUID, picture: 'default' });
			expect(getBridgeLinks(bridge.id)).toHaveLength(1);
		});

		it('lets only the member who linked a name choose its picture', () => {
			const bridge = newBridge();
			saveLink({ bridgeId: bridge.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 5000 });

			expect(setLinkPicture(bridge.id, 'Steve', 'u2', 'skin')).toBe(false);
			expect(setLinkPicture(bridge.id, 'Nobody', 'u1', 'skin')).toBe(false);
			expect(getLink(bridge.id, 'Steve')?.picture).toBe('default');

			expect(setLinkPicture(bridge.id, 'steve', 'u1', 'generated')).toBe(true);
			expect(getLink(bridge.id, 'Steve')?.picture).toBe('generated');
		});

		it("lists a member's links on one server's bridges, alts included", () => {
			const survival = newBridge('g1', 1000);
			const creative = newBridge('g1', 2000);
			const elsewhere = newBridge('g2', 500);
			saveLink({ bridgeId: creative.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 1 });
			saveLink({ bridgeId: survival.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 1 });
			saveLink({ bridgeId: survival.id, name: 'Alex', userId: 'u1', uuid: ALEX_UUID, now: 1 });
			saveLink({ bridgeId: survival.id, name: 'Other', userId: 'u2', uuid: ALEX_UUID, now: 1 });
			saveLink({ bridgeId: elsewhere.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 1 });

			expect(getMemberLinks('g1', 'u1').map((l) => [l.bridge_id, l.name])).toEqual([
				[survival.id, 'Alex'],
				[survival.id, 'Steve'],
				[creative.id, 'Steve'],
			]);
		});

		it('unlinks one name', () => {
			const bridge = newBridge();
			saveLink({ bridgeId: bridge.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 1 });

			expect(deleteLink(bridge.id, 'STEVE')).toBe(true);
			expect(deleteLink(bridge.id, 'Steve')).toBe(false);
			expect(getLink(bridge.id, 'Steve')).toBeUndefined();
		});

		// For a member who has left the server: their links elsewhere stay.
		it("deletes a member's links on one server only", () => {
			const here = newBridge('g1');
			const elsewhere = newBridge('g2');
			saveLink({ bridgeId: here.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 1 });
			saveLink({ bridgeId: here.id, name: 'Alex', userId: 'u1', uuid: ALEX_UUID, now: 1 });
			saveLink({ bridgeId: here.id, name: 'Other', userId: 'u2', uuid: ALEX_UUID, now: 1 });
			saveLink({ bridgeId: elsewhere.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 1 });

			expect(deleteMemberLinks('g1', 'u1')).toBe(2);
			expect(getBridgeLinks(here.id).map((l) => l.user_id)).toEqual(['u2']);
			expect(getBridgeLinks(elsewhere.id)).toHaveLength(1);
		});
	});

	describe('deleting', () => {
		function populate(guildId: string) {
			const bridge = newBridge(guildId);
			setPlayerPicture(bridge.id, 'Steve', 'skin');
			saveLink({ bridgeId: bridge.id, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 1 });
			setAllowedRole(guildId, 'role1');
			return bridge;
		}

		it('deletes a bridge with its pictures and links, and nothing else', () => {
			const bridge = populate('g1');
			const other = populate('g2');

			deleteBridge(bridge.id);

			expect(getBridge(bridge.id)).toBeUndefined();
			expect(getPlayerPictures(bridge.id)).toEqual([]);
			expect(getBridgeLinks(bridge.id)).toEqual([]);
			expect(getMinecraftGuildSettings('g1')).toBeDefined();
			expect(getBridge(other.id)).toBeDefined();
			expect(getPlayerPictures(other.id)).toHaveLength(1);
			expect(getBridgeLinks(other.id)).toHaveLength(1);
		});

		it("deletes everything of a server's when the bot leaves it, and nothing of other servers'", () => {
			populate('g1');
			newBridge('g1');
			const other = populate('g2');

			deleteGuildMinecraftData('g1');

			expect(getGuildBridges('g1')).toEqual([]);
			expect(getMinecraftGuildSettings('g1')).toBeUndefined();
			expect(count('minecraft_bridges')).toBe(1);
			expect(count('minecraft_bridge_pictures')).toBe(1);
			expect(count('minecraft_links')).toBe(1);
			expect(getBridgeLinks(other.id)).toHaveLength(1);
			expect(getMinecraftGuildSettings('g2')).toBeDefined();
		});
	});
});
