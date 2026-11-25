import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTJSONErrorCodes } from 'discord.js';
import { ACCESS_CACHE_MS, serverAccess } from '../../src/dashboard/access.ts';
import { __resetForTests } from '../../src/core/database.ts';
import { setAllowedRole } from '../../src/minecraft/storage.ts';
import { fakeClient, fakeGuild } from './fakeGuilds.ts';

beforeEach(() => {
	__resetForTests();
});

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

describe('rightsIn', () => {
	// u1 owns the server, u2 has the allowed role, u3 another role, u4 Manage Server only, u5 both but in timeout.
	const guild = () =>
		fakeGuild(
			'g1',
			'Shrimp Hall',
			{ u1: false, u2: false, u3: false, u4: true, u5: 'timed out' },
			{},
			{ ownerId: 'u1', roles: { u2: ['r-mc'], u3: ['r-other'], u5: ['r-mc'] } },
		);

	it.each([
		['the owner', 'u1', false, true],
		['a member with the allowed role', 'u2', false, true],
		['a member with another role', 'u3', false, false],
		['a member with Manage Server only', 'u4', true, false],
		['a member in timeout, with Manage Server and the allowed role', 'u5', false, false],
	])('gives %s the right rights, from one fetch', async (_who, userId, manageServer, manageBridges) => {
		setAllowedRole('g1', 'r-mc');
		const server = guild();

		await expect(serverAccess(fakeClient([server])).rightsIn('g1', userId)).resolves.toEqual({
			id: 'g1',
			name: 'Shrimp Hall',
			manageServer,
			manageBridges,
		});
		expect(server.members.fetch).toHaveBeenCalledTimes(1);
	});

	it('leaves bridges to the owner while no role is allowed', async () => {
		await expect(serverAccess(fakeClient([guild()])).rightsIn('g1', 'u2')).resolves.toMatchObject({
			manageBridges: false,
		});
	});

	it('gives an owner in timeout no right', async () => {
		const server = fakeGuild('g1', 'Shrimp Hall', { u1: 'timed out' }, {}, { ownerId: 'u1' });

		await expect(serverAccess(fakeClient([server])).rightsIn('g1', 'u1')).resolves.toMatchObject({
			manageServer: false,
			manageBridges: false,
		});
	});

	it('is null for someone who is not a member', async () => {
		await expect(serverAccess(fakeClient([guild()])).rightsIn('g1', 'u9')).resolves.toBeNull();
	});

	it('shares its answers with serverUserManages', async () => {
		const server = guild();
		const access = serverAccess(fakeClient([server]));

		await access.rightsIn('g1', 'u4');
		await expect(access.serverUserManages('g1', 'u4')).resolves.toEqual({ id: 'g1', name: 'Shrimp Hall' });
		expect(server.members.fetch).toHaveBeenCalledTimes(1);
	});
});

describe('serversWithRights', () => {
	it('lists the servers where the user has either right, by name', async () => {
		const access = serverAccess(
			fakeClient([
				fakeGuild('g1', 'Zeta', { u1: true }),
				fakeGuild('g2', 'Alpha', { u1: false }, {}, { ownerId: 'u1' }),
				fakeGuild('g3', 'Member only', { u1: false }),
				fakeGuild('g4', 'Not a member'),
			]),
		);

		await expect(access.serversWithRights('u1')).resolves.toEqual([
			{ id: 'g2', name: 'Alpha', manageServer: false, manageBridges: true },
			{ id: 'g1', name: 'Zeta', manageServer: true, manageBridges: false },
		]);
	});

	it('leaves out from serversUserManages a server where the user manages only bridges', async () => {
		const access = serverAccess(fakeClient([fakeGuild('g1', 'Alpha', { u1: false }, {}, { ownerId: 'u1' })]));

		await expect(access.serversUserManages('u1')).resolves.toEqual([]);
	});
});
