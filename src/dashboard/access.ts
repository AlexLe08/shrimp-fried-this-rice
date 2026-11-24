import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';

/** What the dashboard uses of a server; discord.js's Guild fits it. */
export interface DashboardGuild {
	id: string;
	name: string;
	members: {
		fetch(options: { user: string; force: boolean }): Promise<{ permissions: { has(permission: bigint): boolean } }>;
	};
}

/** What the dashboard uses of the client; discord.js's Client fits it. */
export interface DashboardClient {
	guilds: { cache: { get(id: string): DashboardGuild | undefined; values(): Iterable<DashboardGuild> } };
}

export interface ManagedServer {
	id: string;
	name: string;
}

/**
 * The server, if the bot is in it and the user may manage it there: Manage
 * Server, the default permission of the commands that change a server's
 * settings (Administrator and the owner have it too). Asked of Discord each
 * time, not taken from the cache: without the privileged Server Members
 * intent the bot doesn't hear of a member's role changes, so a cached member
 * could keep a permission they've lost. Anything else, including an error,
 * is no.
 */
export async function serverUserManages(
	client: DashboardClient,
	guildId: string,
	userId: string,
): Promise<ManagedServer | null> {
	const guild = client.guilds.cache.get(guildId);
	if (!guild) return null;
	try {
		const member = await guild.members.fetch({ user: userId, force: true });
		return member.permissions.has(PermissionFlagsBits.ManageGuild) ? { id: guild.id, name: guild.name } : null;
	} catch (error) {
		// Not a member is the common answer; anything else is worth knowing about.
		if ((error as { code?: unknown }).code !== RESTJSONErrorCodes.UnknownMember) {
			console.error(`Dashboard: couldn't check ${userId}'s permissions in ${guildId}:`, error);
		}
		return null;
	}
}

/** Every server the bot is in that the user may manage, by name. */
export async function serversUserManages(client: DashboardClient, userId: string): Promise<ManagedServer[]> {
	const checks = [...client.guilds.cache.values()].map((guild) => serverUserManages(client, guild.id, userId));
	const servers = (await Promise.all(checks)).filter((server) => server !== null);
	return servers.sort((a, b) => a.name.localeCompare(b.name));
}
