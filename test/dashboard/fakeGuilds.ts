import { vi } from 'vitest';
import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import type { DashboardClient, DashboardGuild } from '../../src/dashboard/access.ts';

/** Who owns a fake server, and each member's roles (by id). */
export interface FakeGuildPeople {
	ownerId?: string;
	roles?: Record<string, string[]>;
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
	return {
		id,
		name,
		ownerId: people.ownerId ?? 'owner-elsewhere',
		members: { fetch },
		channels: { cache: channelCache },
	} satisfies DashboardGuild;
}

export function fakeClient(guilds: DashboardGuild[]): DashboardClient {
	return { guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) } };
}
