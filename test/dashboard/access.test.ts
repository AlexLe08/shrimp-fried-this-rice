import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESTJSONErrorCodes } from 'discord.js';
import { ACCESS_CACHE_MS, serverAccess } from '../../src/dashboard/access.ts';
import { fakeClient, fakeGuild } from './fakeGuilds.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('serverUserManages', () => {
	it('gives the server to a member with Manage Server, asking Discord, not the cache, and caching nothing there', async () => {
		const guild = fakeGuild('g1', 'Shrimp Hall', { u1: true });

		await expect(serverAccess(fakeClient([guild])).serverUserManages('g1', 'u1')).resolves.toEqual({
			id: 'g1',
			name: 'Shrimp Hall',
		});
		expect(guild.members.fetch).toHaveBeenCalledWith({ user: 'u1', force: true, cache: false });
	});

	it('refuses a member without Manage Server', async () => {
		const access = serverAccess(fakeClient([fakeGuild('g1', 'Shrimp Hall', { u1: false })]));

		await expect(access.serverUserManages('g1', 'u1')).resolves.toBeNull();
	});

	it('refuses a member with Manage Server who is in timeout', async () => {
		const access = serverAccess(fakeClient([fakeGuild('g1', 'Shrimp Hall', { u1: 'timed out' })]));

		await expect(access.serverUserManages('g1', 'u1')).resolves.toBeNull();
	});

	it.each([
		['not a member', undefined],
		[
			'a deleted account',
			Object.assign(new Error('Unknown User'), { code: RESTJSONErrorCodes.UnknownUser }) as Error | undefined,
		],
	])('refuses someone who is %s, without logging', async (_case, answer) => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const access = serverAccess(fakeClient([fakeGuild('g1', 'Shrimp Hall', answer ? { u1: answer } : {})]));

		await expect(access.serverUserManages('g1', 'u1')).resolves.toBeNull();
		expect(error).not.toHaveBeenCalled();
	});

	it("refuses a server the bot isn't in, without asking Discord", async () => {
		const guild = fakeGuild('g1', 'Shrimp Hall', { u1: true });

		await expect(serverAccess(fakeClient([guild])).serverUserManages('g2', 'u1')).resolves.toBeNull();
		expect(guild.members.fetch).not.toHaveBeenCalled();
	});

	it('refuses, and logs, when Discord fails', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const access = serverAccess(fakeClient([fakeGuild('g1', 'Shrimp Hall', { u1: new Error('Discord is down') })]));

		await expect(access.serverUserManages('g1', 'u1')).resolves.toBeNull();
		expect(error).toHaveBeenCalledWith("Dashboard: couldn't check u1's permissions in g1:", expect.any(Error));
	});
});

describe('answers reused', () => {
	it(`asks Discord again only once ${ACCESS_CACHE_MS / 1000} s have passed`, async () => {
		let time = 0;
		const guild = fakeGuild('g1', 'Shrimp Hall', { u1: true });
		const access = serverAccess(fakeClient([guild]), () => time);

		await access.serverUserManages('g1', 'u1');
		await access.serversUserManages('u1');
		time += ACCESS_CACHE_MS - 1;
		await access.serverUserManages('g1', 'u1');
		expect(guild.members.fetch).toHaveBeenCalledTimes(1);

		time += 1;
		await access.serverUserManages('g1', 'u1');
		expect(guild.members.fetch).toHaveBeenCalledTimes(2);
	});

	it('shares a check already under way', async () => {
		const guild = fakeGuild('g1', 'Shrimp Hall', { u1: true });
		const access = serverAccess(fakeClient([guild]));

		await Promise.all([access.serverUserManages('g1', 'u1'), access.serverUserManages('g1', 'u1')]);

		expect(guild.members.fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps each user and server apart', async () => {
		const guild = fakeGuild('g1', 'Shrimp Hall', { u1: true, u2: false });
		const access = serverAccess(fakeClient([guild]));

		await expect(access.serverUserManages('g1', 'u1')).resolves.not.toBeNull();
		await expect(access.serverUserManages('g1', 'u2')).resolves.toBeNull();
		expect(guild.members.fetch).toHaveBeenCalledTimes(2);
	});
});

describe('serversUserManages', () => {
	it('lists the servers the user manages, by name', async () => {
		const access = serverAccess(
			fakeClient([
				fakeGuild('g1', 'Zeta', { u1: true }),
				fakeGuild('g2', 'Alpha', { u1: true }),
				fakeGuild('g3', 'Member only', { u1: false }),
				fakeGuild('g4', 'Not a member'),
			]),
		);

		await expect(access.serversUserManages('u1')).resolves.toEqual([
			{ id: 'g2', name: 'Alpha' },
			{ id: 'g1', name: 'Zeta' },
		]);
	});

	it('is empty when the bot is in no servers', async () => {
		await expect(serverAccess(fakeClient([])).serversUserManages('u1')).resolves.toEqual([]);
	});
});
