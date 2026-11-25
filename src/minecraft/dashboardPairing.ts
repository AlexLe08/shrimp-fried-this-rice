import { ChannelType, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import {
	pairBridge,
	regenerateBridge,
	removeBridge,
	type Paired,
	type PairingGuild,
	type PairingMember,
	type PairingRefusal,
	type Regenerated,
	type Removed,
} from './pairing.ts';

// What the dashboard's Minecraft pages need of pairing, from the bot's own
// client. The dashboard sees only this, so its pages are tested with a fake
// and its guild type stays narrow (dashboard/access.ts).

/** A channel the member may pick for a bridge's chat or alerts. */
export interface ChannelChoice {
	id: string;
	name: string;
}

export type PairAnswer = Paired | ({ ok: false } & PairingRefusal);
export type RegenerateAnswer = Regenerated | ({ ok: false } & PairingRefusal);
export type RemoveAnswer = Removed | { ok: false; reason: 'not-allowed' | 'unknown-bridge' | 'error' };

export interface BridgePairing {
	/** Null when the member can't be fetched (gone, or Discord failed). */
	channelChoices(guildId: string, userId: string): Promise<ChannelChoice[] | null>;
	pair(request: {
		guildId: string;
		userId: string;
		chatChannelId: string;
		alertsChannelId: string;
		serverName: string;
		dashboardUrl: string;
	}): Promise<PairAnswer>;
	regenerate(request: {
		guildId: string;
		userId: string;
		bridgeId: string;
		dashboardUrl: string;
	}): Promise<RegenerateAnswer>;
	remove(request: { guildId: string; userId: string; bridgeId: string }): Promise<RemoveAnswer>;
}

interface Permissions {
	has(permission: bigint): boolean;
}

/** Any channel in the server, as discord.js's cache holds it. */
interface ListedChannel<M> {
	id: string;
	name: string;
	type: ChannelType;
	permissionsFor?(member: M): Permissions | null;
}

/** What this uses of a server; discord.js's Guild fits it, with GuildMember as M. */
export interface PairingServer<M extends PairingMember> extends PairingGuild<M> {
	members: PairingGuild<M>['members'] & {
		fetch(options: { user: string; force: boolean; cache: boolean }): Promise<M>;
	};
	channels: PairingGuild<M>['channels'] & { cache: { values(): Iterable<ListedChannel<M>> } };
}

export interface PairingClient<M extends PairingMember> {
	guilds: { cache: { get(id: string): PairingServer<M> | undefined } };
}

/**
 * Fetched from Discord, not the cache: the bot isn't told of role changes
 * without the Server Members intent, and a change checks access fresh
 * (decision 0012). Null for someone who isn't a member, or on any error.
 */
async function freshMember<M extends PairingMember>(guild: PairingServer<M>, userId: string): Promise<M | null> {
	try {
		return await guild.members.fetch({ user: userId, force: true, cache: false });
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code !== RESTJSONErrorCodes.UnknownMember && code !== RESTJSONErrorCodes.UnknownUser) {
			console.error(`Minecraft pairing: couldn't fetch member ${userId} in ${guild.id}:`, error);
		}
		return null;
	}
}

export function bridgePairing<M extends PairingMember>(client: PairingClient<M>): BridgePairing {
	return {
		async channelChoices(guildId, userId) {
			const guild = client.guilds.cache.get(guildId);
			const member = guild && (await freshMember(guild, userId));
			if (!guild || !member) return null;
			// Only channels pairing would accept from them, so the list names no
			// channel they can't see.
			const choices: ChannelChoice[] = [];
			for (const channel of guild.channels.cache.values()) {
				if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
				const theirs = channel.permissionsFor?.(member);
				if (theirs?.has(PermissionFlagsBits.ViewChannel) && theirs.has(PermissionFlagsBits.ManageWebhooks)) {
					choices.push({ id: channel.id, name: channel.name });
				}
			}
			return choices.sort((a, b) => a.name.localeCompare(b.name));
		},

		async pair(request) {
			const guild = client.guilds.cache.get(request.guildId);
			const member = guild && (await freshMember(guild, request.userId));
			if (!guild || !member) return { ok: false, reason: 'not-allowed' };
			return pairBridge({ ...request, guild, member });
		},

		async regenerate(request) {
			const guild = client.guilds.cache.get(request.guildId);
			const member = guild && (await freshMember(guild, request.userId));
			if (!guild || !member) return { ok: false, reason: 'not-allowed' };
			return regenerateBridge({ ...request, guild, member });
		},

		async remove(request) {
			const guild = client.guilds.cache.get(request.guildId);
			const member = guild && (await freshMember(guild, request.userId));
			if (!guild || !member) return { ok: false, reason: 'not-allowed' };
			return removeBridge({ ...request, guild, member });
		},
	};
}
