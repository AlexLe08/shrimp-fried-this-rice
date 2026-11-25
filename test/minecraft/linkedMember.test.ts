import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { RESTJSONErrorCodes, type Guild } from 'discord.js';
import { __resetForTests } from '../../src/core/database.ts';
import { fetchLinkedMember, type LinkedMember, type LinkedMemberGuild } from '../../src/minecraft/linkedMember.ts';
import { createBridge, getBridgeLinks, saveLink, type BridgeKeys } from '../../src/minecraft/storage.ts';

const STEVE_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const ALEX_UUID = '853c80ef-3c37-49fd-aa49-938b674adae6';

function keys(fill: number): BridgeKeys {
	return { request: Buffer.alloc(32, fill), response: Buffer.alloc(32, fill + 1) };
}

function newBridge(guildId: string) {
	return createBridge({
		guildId,
		chat: { channelId: `${guildId}-chat`, webhookId: `${guildId}-wh-chat`, token: 'tok-chat' },
		alerts: { channelId: `${guildId}-alerts`, webhookId: `${guildId}-wh-alerts`, token: 'tok-alerts' },
		keys: keys(1),
		serverName: 'Survival',
		now: 1000,
	});
}

function discordError(message: string, fields: { code?: number; status?: number }): Error {
	return Object.assign(new Error(message), fields);
}

function fakeGuild(id: string, answer: () => Promise<LinkedMember>) {
	return { id, members: { fetch: vi.fn(answer) } };
}

let here: string;
let elsewhere: string;

beforeEach(() => {
	__resetForTests();
	here = newBridge('g1').id;
	elsewhere = newBridge('g2').id;
	saveLink({ bridgeId: here, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 2000 });
	saveLink({ bridgeId: here, name: 'SteveAlt', userId: 'u1', uuid: ALEX_UUID, now: 2000 });
	saveLink({ bridgeId: here, name: 'Alex', userId: 'u2', uuid: ALEX_UUID, now: 2000 });
	saveLink({ bridgeId: elsewhere, name: 'Steve', userId: 'u1', uuid: STEVE_UUID, now: 2000 });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function linkedNames(bridgeId: string): string[] {
	return getBridgeLinks(bridgeId).map((link) => link.name);
}

describe('fetchLinkedMember', () => {
	it("takes discord.js's Guild, whose overloaded members.fetch must still fit", () => {
		expectTypeOf<Guild>().toExtend<LinkedMemberGuild>();
	});

	it('returns the member, asking Discord rather than the cache, and keeps their links', async () => {
		const member = { displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/u1/a.webp' };
		const guild = fakeGuild('g1', async () => member);

		await expect(fetchLinkedMember(guild, 'u1')).resolves.toBe(member);
		expect(guild.members.fetch).toHaveBeenCalledWith({ user: 'u1', force: true, cache: false });
		expect(linkedNames(here)).toEqual(['Alex', 'Steve', 'SteveAlt']);
	});

	it.each([
		['Unknown Member, as they left', RESTJSONErrorCodes.UnknownMember],
		['Unknown User, as the account was deleted', RESTJSONErrorCodes.UnknownUser],
	])("deletes a member's links on that server's bridges on %s", async (name, code) => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const guild = fakeGuild('g1', async () => {
			throw discordError(name, { code, status: 404 });
		});

		await expect(fetchLinkedMember(guild, 'u1')).resolves.toBeNull();
		expect(linkedNames(here)).toEqual(['Alex']);
		// Leaving one server says nothing about another.
		expect(linkedNames(elsewhere)).toEqual(['Steve']);
		expect(log).toHaveBeenCalledWith('Minecraft: u1 is no longer in g1; deleted their 2 link(s).');
	});

	it('logs nothing when a member who left had no links left to delete', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const guild = fakeGuild('g1', async () => {
			throw discordError('Unknown Member', { code: RESTJSONErrorCodes.UnknownMember, status: 404 });
		});

		await expect(fetchLinkedMember(guild, 'u3')).resolves.toBeNull();
		expect(log).not.toHaveBeenCalled();
	});

	it.each([
		['a network error', discordError('getaddrinfo ENOTFOUND discord.com', {})],
		['a 5xx', discordError('Internal Server Error', { status: 500 })],
		['a rate limit', discordError('You are being rate limited.', { status: 429 })],
		['missing access', discordError('Missing Access', { code: RESTJSONErrorCodes.MissingAccess, status: 403 })],
	])('keeps the links and logs on %s, as it proves nothing about membership', async (_case, failure) => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const guild = fakeGuild('g1', async () => {
			throw failure;
		});

		await expect(fetchLinkedMember(guild, 'u1')).resolves.toBeNull();
		expect(linkedNames(here)).toEqual(['Alex', 'Steve', 'SteveAlt']);
		expect(logged).toHaveBeenCalledWith("Minecraft: couldn't look up linked member u1 in g1:", failure);
	});
});
