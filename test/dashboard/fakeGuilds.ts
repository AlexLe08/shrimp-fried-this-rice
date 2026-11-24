import { vi } from 'vitest';
import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import type { DashboardClient, DashboardGuild } from '../../src/dashboard/access.ts';

/**
 * A server the bot is in. `members` maps a user id to whether they have
 * Manage Server there, 'timed out' for one with it but in timeout, or an
 * error Discord answers with; anyone else isn't a member (discord.js
 * rejects with Unknown Member, as Discord answers).
 */
export function fakeGuild(id: string, name: string, members: Record<string, boolean | 'timed out' | Error> = {}) {
	const fetch = vi.fn(async ({ user }: { user: string; force: boolean; cache: boolean }) => {
		const entry = members[user];
		if (entry === undefined)
			throw Object.assign(new Error('Unknown Member'), { code: RESTJSONErrorCodes.UnknownMember });
		if (entry instanceof Error) throw entry;
		return {
			permissions: { has: (permission: bigint) => entry !== false && permission === PermissionFlagsBits.ManageGuild },
			isCommunicationDisabled: () => entry === 'timed out',
		};
	});
	return { id, name, members: { fetch } } satisfies DashboardGuild;
}

export function fakeClient(guilds: DashboardGuild[]): DashboardClient {
	return { guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) } };
}
