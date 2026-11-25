import { ChannelType, PermissionFlagsBits, RESTJSONErrorCodes, type Guild, type GuildMember } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetForTests } from '../../src/core/database.ts';
import { parseConfig } from '../../src/minecraft/bridge/config.ts';
import { deriveKeys } from '../../src/minecraft/bridge/seal.ts';
import {
	canManageBridges,
	pairBridge,
	regenerateBridge,
	type PairingGuild,
	type PairingMember,
} from '../../src/minecraft/pairing.ts';
import { deleteBridge, getBridge, getGuildBridges, setAllowedRole } from '../../src/minecraft/storage.ts';

// The dashboard will pass discord.js's own objects; checked here by tsc, as
// nothing in src/ calls pairing yet.
export const realGuildFits = (guild: Guild): PairingGuild<GuildMember> => guild;

const DASHBOARD = 'https://dash.example';
const OWNER = 'owner';
const BOT = 'bot';

interface FakeMember extends PairingMember {
	timedOut: boolean;
}

function fakeMember(id: string, roles: string[] = []): FakeMember {
	return {
		id,
		roles: { cache: new Set(roles) },
		timedOut: false,
		isCommunicationDisabled() {
			return this.timedOut;
		},
	};
}

/** Every webhook made and deleted, to check nothing live is left unrecorded. */
let made: string[];
let deleted: string[];
let nextWebhook: number;

function fakeChannel(
	id: string,
	options: {
		type?: ChannelType;
		/** Whether a member (by id) has a permission in this channel. */
		allows?: (memberId: string, permission: bigint) => boolean;
	} = {},
) {
	const allows = options.allows ?? (() => true);
	return {
		id,
		type: options.type ?? ChannelType.GuildText,
		permissionsFor: (member: FakeMember) => ({ has: (permission: bigint) => allows(member.id, permission) }),
		createWebhook: vi.fn<(options: { name: string; reason?: string }) => Promise<{ id: string; token: string | null }>>(
			async () => {
				const webhook = { id: String(900 + nextWebhook), token: `tok${nextWebhook}` };
				nextWebhook += 1;
				made.push(webhook.id);
				return webhook;
			},
		),
	};
}

type FakeChannel = ReturnType<typeof fakeChannel>;

function fakeGuild(channels: FakeChannel[], options: { id?: string; me?: FakeMember | null } = {}) {
	const cache = new Map<string, FakeChannel>(channels.map((channel) => [channel.id, channel]));
	return {
		id: options.id ?? 'g1',
		ownerId: OWNER,
		members: { me: options.me === undefined ? fakeMember(BOT) : options.me },
		channels: { cache },
		client: {
			deleteWebhook: vi.fn<(id: string, options?: { reason?: string }) => Promise<void>>(async (id) => {
				deleted.push(id);
			}),
		},
	};
}

function discordError(code: number) {
	return Object.assign(new Error(`Discord error ${code}`), { code });
}

let chat: FakeChannel;
let alerts: FakeChannel;
let guild: ReturnType<typeof fakeGuild>;
let owner: FakeMember;

function pair(overrides: Partial<Parameters<typeof pairBridge<FakeMember>>[0]> = {}) {
	return pairBridge({
		guild,
		member: owner,
		chatChannelId: 'chat',
		alertsChannelId: 'alerts',
		serverName: 'Survival',
		dashboardUrl: DASHBOARD,
		now: 1000,
		...overrides,
	});
}

async function paired() {
	const result = await pair();
	if (!result.ok) throw new Error(`pairing refused: ${result.reason}`);
	return result;
}

function regenerate(bridgeId: string, member: FakeMember = owner) {
	return regenerateBridge({ guild, member, bridgeId, dashboardUrl: DASHBOARD });
}

beforeEach(() => {
	__resetForTests();
	made = [];
	deleted = [];
	nextWebhook = 1;
	chat = fakeChannel('chat');
	alerts = fakeChannel('alerts');
	guild = fakeGuild([chat, alerts]);
	owner = fakeMember(OWNER);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('canManageBridges', () => {
	it("lets the server's owner and the allowed role manage bridges, and nobody in timeout", () => {
		const moderator = fakeMember('mod', ['mods']);
		expect(canManageBridges(guild, owner)).toBe(true);
		expect(canManageBridges(guild, moderator)).toBe(false);

		setAllowedRole('g1', 'mods');
		expect(canManageBridges(guild, moderator)).toBe(true);
		expect(canManageBridges(guild, fakeMember('someone', ['other']))).toBe(false);

		moderator.timedOut = true;
		owner.timedOut = true;
		expect(canManageBridges(guild, moderator)).toBe(false);
		expect(canManageBridges(guild, owner)).toBe(false);
	});

	it("doesn't carry an allowed role over to another server", () => {
		setAllowedRole('g2', 'mods');
		expect(canManageBridges(guild, fakeMember('mod', ['mods']))).toBe(false);
	});
});

describe('pairBridge', () => {
	it('makes both webhooks and a secret, storing only the keys, and hands over a config the helper accepts', async () => {
		const { bridge, config } = await paired();

		expect(chat.createWebhook).toHaveBeenCalledWith({
			name: 'Minecraft chat',
			reason: 'Minecraft bridge "Survival" paired by member owner',
		});
		expect(alerts.createWebhook).toHaveBeenCalledWith({
			name: 'Minecraft alerts',
			reason: 'Minecraft bridge "Survival" paired by member owner',
		});
		expect(config).toEqual({
			serverName: 'Survival',
			logPath: '',
			webhooks: {
				chat: 'https://discord.com/api/webhooks/901/tok1',
				alerts: 'https://discord.com/api/webhooks/902/tok2',
			},
			bot: { url: 'https://dash.example/minecraft', secret: config.bot.secret },
		});
		expect(bridge).toMatchObject({
			guild_id: 'g1',
			chat_channel_id: 'chat',
			chat_webhook_id: '901',
			chat_webhook_token: 'tok1',
			alerts_channel_id: 'alerts',
			alerts_webhook_id: '902',
			alerts_webhook_token: 'tok2',
			server_name: 'Survival',
			created_at: 1000,
		});
		const keys = deriveKeys(config.bot.secret);
		expect(bridge.request_key.equals(keys.request)).toBe(true);
		expect(bridge.response_key.equals(keys.response)).toBe(true);
		expect(JSON.stringify(getBridge(bridge.id))).not.toContain(config.bot.secret);

		expect(parseConfig({ ...config, logPath: '/srv/logs/latest.log' }).bot).toEqual(config.bot);
	});

	it('gives each pairing its own secret and bridge', async () => {
		const first = await paired();
		const second = await paired();
		expect(second.config.bot.secret).not.toBe(first.config.bot.secret);
		expect(second.bridge.id).not.toBe(first.bridge.id);
		expect(getGuildBridges('g1')).toHaveLength(2);
	});

	it('makes two webhooks when chat and alerts share a channel', async () => {
		const { bridge } = await paired()
			.then(() => pair({ alertsChannelId: 'chat' }))
			.then((result) => {
				if (!result.ok) throw new Error(result.reason);
				return result;
			});
		expect(bridge.chat_webhook_id).not.toBe(bridge.alerts_webhook_id);
		expect(bridge.alerts_channel_id).toBe('chat');
	});

	it('refuses a member who may not manage bridges, before making anything', async () => {
		expect(await pair({ member: fakeMember('someone') })).toEqual({ ok: false, reason: 'not-allowed' });
		expect(made).toEqual([]);
	});

	it('refuses a server name the helper would refuse', async () => {
		expect(await pair({ serverName: 'Discord SMP' })).toEqual({
			ok: false,
			reason: 'bad-name',
			problem: '"serverName" can\'t contain "clyde" or "discord"',
		});
		expect(await pair({ serverName: ' ' })).toMatchObject({ ok: false, reason: 'bad-name' });
		expect(made).toEqual([]);
	});

	it('takes only text and announcement channels the bot can see', async () => {
		guild = fakeGuild([
			chat,
			fakeChannel('news', { type: ChannelType.GuildAnnouncement }),
			fakeChannel('forum', { type: ChannelType.GuildForum }),
			fakeChannel('voice', { type: ChannelType.GuildVoice }),
		]);
		expect(await pair({ alertsChannelId: 'news' })).toMatchObject({ ok: true });
		for (const channelId of ['forum', 'voice', 'gone']) {
			expect(await pair({ alertsChannelId: channelId })).toEqual({
				ok: false,
				reason: 'unusable-channel',
				channelId,
			});
		}
		expect(made).toHaveLength(2);
	});

	it("refuses a channel where the member can't see or manage webhooks, so no webhook URL reaches them", async () => {
		setAllowedRole('g1', 'mods');
		const moderator = fakeMember('mod', ['mods']);
		for (const lacking of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageWebhooks]) {
			alerts = fakeChannel('alerts', { allows: (id, permission) => id !== 'mod' || permission !== lacking });
			guild = fakeGuild([chat, alerts]);
			expect(await pair({ member: moderator })).toEqual({
				ok: false,
				reason: 'member-cant-manage-channel',
				channelId: 'alerts',
			});
		}
		expect(made).toEqual([]);
	});

	it('names what the bot lacks, needing Read Message History only in the chat channel', async () => {
		const noHistory = (id: string, permission: bigint) =>
			id !== BOT || permission !== PermissionFlagsBits.ReadMessageHistory;
		guild = fakeGuild([fakeChannel('chat', { allows: noHistory }), fakeChannel('alerts', { allows: noHistory })]);
		expect(await pair()).toEqual({
			ok: false,
			reason: 'bot-missing-permissions',
			channelId: 'chat',
			missing: ['ReadMessageHistory'],
		});
		expect(await pair({ chatChannelId: 'alerts', alertsChannelId: 'chat' })).toMatchObject({
			ok: false,
			channelId: 'alerts',
		});

		const nothing = (id: string) => id !== BOT;
		guild = fakeGuild([chat, fakeChannel('alerts', { allows: nothing })]);
		expect(await pair()).toEqual({
			ok: false,
			reason: 'bot-missing-permissions',
			channelId: 'alerts',
			missing: ['ViewChannel', 'ManageWebhooks'],
		});
		expect(made).toEqual([]);
	});

	it("refuses while the bot's own member isn't cached", async () => {
		guild = fakeGuild([chat, alerts], { me: null });
		expect(await pair()).toEqual({ ok: false, reason: 'discord-error' });
	});

	it.each([
		[
			RESTJSONErrorCodes.MaximumNumberOfWebhooksReached,
			{ reason: 'webhook-limit', channelId: 'alerts', scope: 'channel' },
		],
		[
			RESTJSONErrorCodes.MaximumNumberOfWebhooksPerGuildReached,
			{ reason: 'webhook-limit', channelId: 'alerts', scope: 'server' },
		],
		[
			RESTJSONErrorCodes.MissingPermissions,
			{ reason: 'bot-missing-permissions', channelId: 'alerts', missing: ['ManageWebhooks'] },
		],
		[RESTJSONErrorCodes.UnknownChannel, { reason: 'unusable-channel', channelId: 'alerts' }],
	])('deletes the chat webhook when Discord refuses the alerts one (%i)', async (code, refusal) => {
		alerts.createWebhook.mockRejectedValueOnce(discordError(code));
		expect(await pair()).toEqual({ ok: false, ...refusal });
		expect(made).toEqual(['901']);
		expect(deleted).toEqual(['901']);
		expect(getGuildBridges('g1')).toEqual([]);
	});

	it('logs an unexpected failure, leaving nothing behind', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		alerts.createWebhook.mockRejectedValueOnce(new Error('socket hang up'));
		expect(await pair()).toEqual({ ok: false, reason: 'discord-error' });
		expect(deleted).toEqual(['901']);
		expect(error).toHaveBeenCalledWith("Minecraft pairing: couldn't make a webhook in alerts:", expect.any(Error));
	});

	it('deletes a webhook that came back without a token', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		chat.createWebhook.mockResolvedValueOnce({ id: '999', token: null });
		expect(await pair()).toEqual({ ok: false, reason: 'discord-error' });
		expect(deleted).toEqual(['999']);
		expect(alerts.createWebhook).not.toHaveBeenCalled();
	});
});

describe('regenerateBridge', () => {
	it('replaces the secret and both webhooks, then deletes the old webhooks', async () => {
		const first = await paired();
		const result = await regenerate(first.bridge.id);
		if (!result.ok) throw new Error(result.reason);

		expect(result.config.bot.secret).not.toBe(first.config.bot.secret);
		expect(result.config.webhooks).toEqual({
			chat: 'https://discord.com/api/webhooks/903/tok3',
			alerts: 'https://discord.com/api/webhooks/904/tok4',
		});
		const stored = getBridge(first.bridge.id)!;
		const keys = deriveKeys(result.config.bot.secret);
		expect(stored.request_key.equals(keys.request)).toBe(true);
		expect(stored.response_key.equals(keys.response)).toBe(true);
		expect(stored).toMatchObject({ chat_webhook_id: '903', alerts_webhook_id: '904', server_name: 'Survival' });
		expect(deleted).toEqual(['901', '902']);
		expect(guild.client.deleteWebhook).toHaveBeenCalledWith('901', {
			reason: 'Minecraft bridge "Survival" regenerated by member owner',
		});
		expect(result.undeletedWebhooks).toEqual([]);
	});

	it("lists an old webhook Discord wouldn't delete, as it still posts, but not one already gone", async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { bridge } = await paired();
		guild.client.deleteWebhook
			.mockRejectedValueOnce(discordError(RESTJSONErrorCodes.UnknownWebhook))
			.mockRejectedValueOnce(new Error('503'));
		const result = await regenerate(bridge.id);
		expect(result).toMatchObject({ ok: true, undeletedWebhooks: [{ channelId: 'alerts', webhookId: '902' }] });
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("refuses another server's bridge, an unknown one and a member who may not manage bridges", async () => {
		const { bridge } = await paired();
		const otherGuild = fakeGuild([chat, alerts], { id: 'g2' });
		made = [];
		expect(
			await regenerateBridge({ guild: otherGuild, member: owner, bridgeId: bridge.id, dashboardUrl: DASHBOARD }),
		).toEqual({
			ok: false,
			reason: 'unknown-bridge',
		});
		expect(await regenerate('no-such-bridge')).toEqual({ ok: false, reason: 'unknown-bridge' });
		expect(await regenerate(bridge.id, fakeMember('someone'))).toEqual({ ok: false, reason: 'not-allowed' });
		expect(made).toEqual([]);
	});

	it("refuses a manager who can't manage the bridge's channel's webhooks", async () => {
		const { bridge } = await paired();
		setAllowedRole('g1', 'mods');
		chat.permissionsFor = (member) => ({
			has: (permission) => member.id !== 'mod' || permission !== PermissionFlagsBits.ManageWebhooks,
		});
		expect(await regenerate(bridge.id, fakeMember('mod', ['mods']))).toEqual({
			ok: false,
			reason: 'member-cant-manage-channel',
			channelId: 'chat',
		});
	});

	it('deletes the new webhooks if the bridge was removed while they were made', async () => {
		const { bridge } = await paired();
		alerts.createWebhook.mockImplementationOnce(async () => {
			deleteBridge(bridge.id);
			made.push('904');
			return { id: '904', token: 'tok4' };
		});
		expect(await regenerate(bridge.id)).toEqual({ ok: false, reason: 'unknown-bridge' });
		expect(deleted).toEqual(['903', '904']);
	});

	it('leaves only the saved webhooks live when two regenerations overlap', async () => {
		const { bridge } = await paired();
		const results = await Promise.all([regenerate(bridge.id), regenerate(bridge.id)]);
		expect(results.every((result) => result.ok)).toBe(true);

		const stored = getBridge(bridge.id)!;
		const live = made.filter((id) => !deleted.includes(id));
		expect(live.sort()).toEqual([stored.chat_webhook_id, stored.alerts_webhook_id].sort());
	});
});
