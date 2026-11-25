import { vi } from 'vitest';
import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import type { DashboardClient, DashboardGuild } from '../../src/dashboard/access.ts';

/** Who owns a fake server, and each member's roles (by id). */
export interface FakeGuildPeople {
	ownerId?: string;
	roles?: Record<string, string[]>;
	/** The server's roles in its cache, by id: a name, or a name and whether an integration manages it. */
	serverRoles?: Record<string, string | { name: string; managed: boolean }>;
	/** Members in the bot's cache, by id: their display name and username. */
	cached?: Record<string, { displayName: string; username: string }>;
}

/**
 * A server the bot is in. `members` maps a user id to whether they have
 * Manage Server there, 'timed out' for one with it but in timeout, or an
 * error Discord answers with; anyone else isn't a member (discord.js
 * rejects with Unknown Member, as Discord answers). `channels` maps a
 * channel id to its name, for those in the bot's cache. `people` sets its
 * owner (else nobody here) and members' roles, for who may manage bridges.
 */
export function fakeGuild(
	id: string,
	name: string,
	members: Record<string, boolean | 'timed out' | Error> = {},
	channels: Record<string, string> = {},
	people: FakeGuildPeople = {},
) {
	const fetch = vi.fn(async ({ user }: { user: string; force: boolean; cache: boolean }) => {
		const entry = members[user];
		if (entry === undefined)
			throw Object.assign(new Error('Unknown Member'), { code: RESTJSONErrorCodes.UnknownMember });
		if (entry instanceof Error) throw entry;
		return {
			id: user,
			roles: { cache: { has: (roleId: string) => people.roles?.[user]?.includes(roleId) ?? false } },
			permissions: { has: (permission: bigint) => entry !== false && permission === PermissionFlagsBits.ManageGuild },
			isCommunicationDisabled: () => entry === 'timed out',
		};
	});
	const channelCache = new Map(
		Object.entries(channels).map(([channelId, channelName]) => [channelId, { name: channelName }]),
	);
	// Listed in the order given, highest first, as Discord's positions go.
	const roleEntries = Object.entries(people.serverRoles ?? {});
	const roleCache = new Map(
		roleEntries.map(([roleId, role], index) => {
			const { name: roleName, managed } = typeof role === 'string' ? { name: role, managed: false } : role;
			return [roleId, { id: roleId, name: roleName, managed, position: roleEntries.length - index }];
		}),
	);
	const memberCache = new Map(
		Object.entries(people.cached ?? {}).map(([userId, { displayName, username }]) => [
			userId,
			{ displayName, user: { username } },
		]),
	);
	return {
		id,
		name,
		ownerId: people.ownerId ?? 'owner-elsewhere',
		members: { fetch, cache: memberCache },
		channels: { cache: channelCache },
		roles: { cache: roleCache },
	} satisfies DashboardGuild;
}

export function fakeClient(guilds: DashboardGuild[]): DashboardClient {
	return { guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) } };
}
