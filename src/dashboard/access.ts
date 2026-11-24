import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';

/** What the dashboard uses of a member; discord.js's GuildMember fits it. */
export interface DashboardMember {
	permissions: { has(permission: bigint): boolean };
	isCommunicationDisabled(): boolean;
}

/** What the dashboard uses of a server; discord.js's Guild fits it. */
export interface DashboardGuild {
	id: string;
	name: string;
	members: { fetch(options: { user: string; force: boolean; cache: boolean }): Promise<DashboardMember> };
	/** Kept current by the Guilds intent, so reading a channel's name asks Discord nothing. */
	channels: { cache: { get(id: string): { name: string } | undefined } };
}

/** What the dashboard uses of the client; discord.js's Client fits it. */
export interface DashboardClient {
	guilds: { cache: { get(id: string): DashboardGuild | undefined; values(): Iterable<DashboardGuild> } };
}

export interface ManagedServer {
	id: string;
	name: string;
}

export interface ServerAccess {
	/** The server, if the bot is in it and the user may manage it there. */
	serverUserManages(guildId: string, userId: string): Promise<ManagedServer | null>;
	/** Every server the bot is in that the user may manage, by name. */
	serversUserManages(userId: string): Promise<ManagedServer[]>;
}

// How long an answer is reused. Each one costs a Discord call through the
// request queue reminders and command replies share, so reloading a page
// mustn't make one every time; a permission lost takes this long to apply.
export const ACCESS_CACHE_MS = 30_000;

// Neither is a member: Discord's answers for someone not in the server, and for a deleted account.
const NOT_A_MEMBER = new Set<unknown>([RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser]);

/**
 * Manage Server decides: the default permission of the commands that change
 * a server's settings (Administrator and the owner have it too). A member in
 * timeout is refused, as Discord refuses them commands too, though
 * discord.js's permissions ignore it. Asked of Discord, not taken from the
 * cache: without the privileged Server Members intent the bot doesn't hear of
 * a member's role changes, so a cached member could keep a permission they've
 * lost. Anything else, an error included, is no: the guard answers the same
 * 404 for all of them, so a manager sees "Not found" during a Discord outage
 * rather than a page that would say the bot is in that server.
 */
async function askDiscord(guild: DashboardGuild, userId: string): Promise<ManagedServer | null> {
	try {
		const member = await guild.members.fetch({ user: userId, force: true, cache: false });
		const manages = member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.isCommunicationDisabled();
		return manages ? { id: guild.id, name: guild.name } : null;
	} catch (error) {
		if (!NOT_A_MEMBER.has((error as { code?: unknown }).code)) {
			console.error(`Dashboard: couldn't check ${userId}'s permissions in ${guild.id}:`, error);
		}
		return null;
	}
}

export function serverAccess(client: DashboardClient, now: () => number = Date.now): ServerAccess {
	// Promises, so a check already under way is shared rather than repeated.
	const answers = new Map<string, { expiresAt: number; answer: Promise<ManagedServer | null> }>();

	function check(guild: DashboardGuild, userId: string): Promise<ManagedServer | null> {
		const time = now();
		const key = `${guild.id}:${userId}`;
		const cached = answers.get(key);
		if (cached && cached.expiresAt > time) return cached.answer;
		for (const [oldKey, old] of answers) if (old.expiresAt <= time) answers.delete(oldKey);
		const answer = askDiscord(guild, userId);
		answers.set(key, { expiresAt: time + ACCESS_CACHE_MS, answer });
		return answer;
	}

	return {
		async serverUserManages(guildId, userId) {
			// A server the bot isn't in answers at once, without asking Discord; the
			// timing shows only whether the bot is in a server with that id.
			const guild = client.guilds.cache.get(guildId);
			return guild ? check(guild, userId) : null;
		},
		async serversUserManages(userId) {
			const checks = [...client.guilds.cache.values()].map((guild) => check(guild, userId));
			const servers = (await Promise.all(checks)).filter((server) => server !== null);
			return servers.sort((a, b) => a.name.localeCompare(b.name));
		},
	};
}
