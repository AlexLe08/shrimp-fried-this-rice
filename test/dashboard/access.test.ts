import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverUserManages, serversUserManages } from '../../src/dashboard/access.ts';
import { fakeClient, fakeGuild } from './fakeGuilds.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('serverUserManages', () => {
	it('gives the server to a member with Manage Server, asking Discord rather than the cache', async () => {
		const guild = fakeGuild('g1', 'Shrimp Hall', { u1: true });

		await expect(serverUserManages(fakeClient([guild]), 'g1', 'u1')).resolves.toEqual({
			id: 'g1',
			name: 'Shrimp Hall',
		});
		expect(guild.members.fetch).toHaveBeenCalledWith({ user: 'u1', force: true });
	});

	it('refuses a member without Manage Server', async () => {
		const client = fakeClient([fakeGuild('g1', 'Shrimp Hall', { u1: false })]);

		await expect(serverUserManages(client, 'g1', 'u1')).resolves.toBeNull();
	});

	it("refuses someone who isn't a member, without logging", async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = fakeClient([fakeGuild('g1', 'Shrimp Hall')]);

		await expect(serverUserManages(client, 'g1', 'u1')).resolves.toBeNull();
		expect(error).not.toHaveBeenCalled();
	});

	it("refuses a server the bot isn't in, without asking Discord", async () => {
		const guild = fakeGuild('g1', 'Shrimp Hall', { u1: true });

		await expect(serverUserManages(fakeClient([guild]), 'g2', 'u1')).resolves.toBeNull();
		expect(guild.members.fetch).not.toHaveBeenCalled();
	});

	it('refuses, and logs, when Discord fails', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = fakeClient([fakeGuild('g1', 'Shrimp Hall', { u1: new Error('Discord is down') })]);

		await expect(serverUserManages(client, 'g1', 'u1')).resolves.toBeNull();
		expect(error).toHaveBeenCalledWith("Dashboard: couldn't check u1's permissions in g1:", expect.any(Error));
	});
});

describe('serversUserManages', () => {
	it('lists the servers the user manages, by name', async () => {
		const client = fakeClient([
			fakeGuild('g1', 'Zeta', { u1: true }),
			fakeGuild('g2', 'Alpha', { u1: true }),
			fakeGuild('g3', 'Member only', { u1: false }),
			fakeGuild('g4', 'Not a member'),
		]);

		await expect(serversUserManages(client, 'u1')).resolves.toEqual([
			{ id: 'g2', name: 'Alpha' },
			{ id: 'g1', name: 'Zeta' },
		]);
	});

	it('is empty when the bot is in no servers', async () => {
		await expect(serversUserManages(fakeClient([]), 'u1')).resolves.toEqual([]);
	});
});
