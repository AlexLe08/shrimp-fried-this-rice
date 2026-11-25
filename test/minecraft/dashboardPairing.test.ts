import { ChannelType, PermissionFlagsBits, RESTJSONErrorCodes, type Client, type GuildMember } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetForTests } from '../../src/core/database.ts';
import { bridgePairing, type PairingClient } from '../../src/minecraft/dashboardPairing.ts';
import type { PairingMember } from '../../src/minecraft/pairing.ts';
import { getGuildBridges } from '../../src/minecraft/storage.ts';

// index.ts passes discord.js's own client; checked here by tsc.
export const realClientFits = (client: Client): PairingClient<GuildMember> => client;

const OWNER = 'owner';

function member(id: string): PairingMember {
	return { id, roles: { cache: new Set<string>() }, isCommunicationDisabled: () => false };
}

/** `allows` says whether a member (by id) has a permission in the channel. */
function channel(
	id: string,
	name: string,
	options: { type?: ChannelType; allows?: (memberId: string, permission: bigint) => boolean } = {},
) {
	const allows = options.allows ?? (() => true);
	return {
		id,
		name,
		type: options.type ?? ChannelType.GuildText,
		permissionsFor: (who: PairingMember) => ({ has: (permission: bigint) => allows(who.id, permission) }),
		createWebhook: vi.fn(async () => ({ id: `wh-${id}-${Math.random()}`, token: 'tok' })),
	};
}

function client(channels: ReturnType<typeof channel>[], fetch: (user: string) => Promise<PairingMember>) {
	const guild = {
		id: 'g1',
		ownerId: OWNER,
		members: { me: member('bot'), fetch: vi.fn(async ({ user }: { user: string }) => fetch(user)) },
		channels: { cache: new Map(channels.map((c) => [c.id, c])) },
		client: { deleteWebhook: vi.fn(async () => {}) },
	};
	return { guild, client: { guilds: { cache: new Map([['g1', guild]]) } } };
}

const known = async (user: string) => member(user);
const unknownMember = async () => {
	throw Object.assign(new Error('Unknown Member'), { code: RESTJSONErrorCodes.UnknownMember });
};

beforeEach(() => {
	__resetForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('channelChoices', () => {
	it('offers text and announcement channels where the member can see and manage webhooks, by name, fetched fresh', async () => {
		const noWebhooks = (who: string, permission: bigint) =>
			who !== OWNER || permission !== PermissionFlagsBits.ManageWebhooks;
		const { guild, client: fake } = client(
			[
				channel('c1', 'zeta'),
				channel('c2', 'alpha', { type: ChannelType.GuildAnnouncement }),
				channel('c3', 'voice', { type: ChannelType.GuildVoice }),
				channel('c4', 'forum', { type: ChannelType.GuildForum }),
				channel('c5', 'hidden', { allows: (who) => who !== OWNER }),
				channel('c6', 'no-webhooks', { allows: noWebhooks }),
			],
			known,
		);

		await expect(bridgePairing(fake).channelChoices('g1', OWNER)).resolves.toEqual([
			{ id: 'c2', name: 'alpha' },
			{ id: 'c1', name: 'zeta' },
		]);
		expect(guild.members.fetch).toHaveBeenCalledWith({ user: OWNER, force: true, cache: false });
	});

	it('is null for a server the bot is not in, or someone not a member, without logging', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { client: fake } = client([channel('c1', 'chat')], unknownMember);

		await expect(bridgePairing(fake).channelChoices('g9', OWNER)).resolves.toBeNull();
		await expect(bridgePairing(fake).channelChoices('g1', OWNER)).resolves.toBeNull();
		expect(error).not.toHaveBeenCalled();
	});

	it('is null, and logs, when Discord fails', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { client: fake } = client([channel('c1', 'chat')], async () => {
			throw new Error('Discord is down');
		});

		await expect(bridgePairing(fake).channelChoices('g1', OWNER)).resolves.toBeNull();
		expect(error).toHaveBeenCalledWith("Minecraft pairing: couldn't fetch member owner in g1:", expect.any(Error));
	});
});

describe('pair', () => {
	const request = {
		guildId: 'g1',
		userId: OWNER,
		chatChannelId: 'c1',
		alertsChannelId: 'c2',
		serverName: 'Survival',
		dashboardUrl: 'https://dash.example',
	};

	it('pairs as the freshly fetched member', async () => {
		const { guild, client: fake } = client([channel('c1', 'chat'), channel('c2', 'alerts')], known);

		const answer = await bridgePairing(fake).pair(request);

		expect(answer).toMatchObject({ ok: true, config: { serverName: 'Survival' } });
		expect(guild.members.fetch).toHaveBeenCalledWith({ user: OWNER, force: true, cache: false });
		expect(getGuildBridges('g1')).toHaveLength(1);
	});

	it("refuses a member pairing wouldn't allow", async () => {
		const { client: fake } = client([channel('c1', 'chat'), channel('c2', 'alerts')], known);

		await expect(bridgePairing(fake).pair({ ...request, userId: 'someone' })).resolves.toEqual({
			ok: false,
			reason: 'not-allowed',
		});
	});

	it('refuses, making nothing, when the member is gone or the bot is not in the server', async () => {
		const chat = channel('c1', 'chat');
		const { client: fake } = client([chat, channel('c2', 'alerts')], unknownMember);

		await expect(bridgePairing(fake).pair(request)).resolves.toEqual({ ok: false, reason: 'not-allowed' });
		await expect(bridgePairing(fake).pair({ ...request, guildId: 'g9' })).resolves.toEqual({
			ok: false,
			reason: 'not-allowed',
		});
		expect(chat.createWebhook).not.toHaveBeenCalled();
		expect(getGuildBridges('g1')).toEqual([]);
	});
});
