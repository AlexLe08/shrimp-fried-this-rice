import { RESTJSONErrorCodes, type ImageURLOptions } from 'discord.js';
import { deleteMemberLinks } from './storage.ts';

/** What a link uses of its member; discord.js's GuildMember fits it. */
export interface LinkedMember {
	/** Their picture in that server: the per-server one, then their own, then Discord's default (decision 0007's `discord`). */
	displayAvatarURL(options?: ImageURLOptions): string;
}

/** What looking up a linked member uses of a server; discord.js's Guild fits it. */
export interface LinkedMemberGuild {
	id: string;
	members: { fetch(options: { user: string; force: boolean; cache: boolean }): Promise<LinkedMember> };
}

const GONE = new Set<unknown>([RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser]);

/**
 * The member behind a link, or null to fall back to the bridge's own
 * pictures (decision 0007). Asked of Discord, not the cache: without the
 * privileged Server Members intent the bot isn't told when someone leaves,
 * so a cached member would outlive their membership. Fetching one member
 * needs no intent (checked in Discord's docs, 2026-11-24; only listing
 * members does).
 *
 * Only Discord saying they're gone deletes their links on this server's
 * bridges: Unknown Member (they left) or Unknown User (the account was
 * deleted), as the dashboard's access check reads them too. A network error,
 * a 5xx or a rate limit says nothing about membership, and deleting then
 * would make them link again after every Discord outage.
 */
export async function fetchLinkedMember(guild: LinkedMemberGuild, userId: string): Promise<LinkedMember | null> {
	try {
		return await guild.members.fetch({ user: userId, force: true, cache: false });
	} catch (error) {
		if (GONE.has((error as { code?: unknown } | null)?.code)) {
			const deleted = deleteMemberLinks(guild.id, userId);
			if (deleted > 0) {
				console.log(`Minecraft: ${userId} is no longer in ${guild.id}; deleted their ${deleted} link(s).`);
			}
		} else {
			console.error(`Minecraft: couldn't look up linked member ${userId} in ${guild.id}:`, error);
		}
		return null;
	}
}
