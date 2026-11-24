import { randomBytes } from 'node:crypto';
import { db } from '../core/database.ts';

// Row shapes, written by hand: query results are cast to these unchecked,
// so a column change updates its interface in the same commit.
export interface MinecraftGuildSettings {
	guild_id: string;
	allowed_role_id: string | null;
}

/** What the bridge's settings may set as everyone's picture (as the helper's `avatars.default`). */
export type DefaultPicture = 'generated' | 'skin' | 'none';
/** A player's picture set for them by the bridge's managers (as the helper's `avatars.players`, without URLs). */
export type PlayerPicture = DefaultPicture | `generated:${number}`;
/** A linked player's own choice; `default` leaves it to the bridge's settings. */
export type LinkPicture = 'discord' | 'skin' | 'generated' | 'default';

export interface MinecraftBridge {
	id: string;
	guild_id: string;
	chat_channel_id: string;
	chat_webhook_id: string;
	chat_webhook_token: string;
	alerts_channel_id: string;
	alerts_webhook_id: string;
	alerts_webhook_token: string;
	request_key: Buffer;
	response_key: Buffer;
	server_name: string;
	prefix: string;
	colour: string;
	default_picture: DefaultPicture | null;
	announced_channel_id: string | null;
	last_relayed_message_id: string | null;
	created_at: number;
}

export interface MinecraftBridgePicture {
	bridge_id: string;
	name: string;
	name_key: string;
	picture: PlayerPicture;
}

export interface MinecraftLink {
	bridge_id: string;
	name: string;
	name_key: string;
	user_id: string;
	uuid: string;
	picture: LinkPicture;
	linked_at: number;
}

/** A webhook the bot made in a bridge's channel. */
export interface BridgeWebhook {
	channelId: string;
	webhookId: string;
	token: string;
}

/** The keys derived from a bridge's secret, one per direction. */
export interface BridgeKeys {
	request: Buffer;
	response: Buffer;
}

// Minecraft names are unique whatever their case, so "steve" finds "Steve".
export function playerNameKey(name: string): string {
	return name.toLowerCase();
}

// --- Who may manage bridges ---
export function getMinecraftGuildSettings(guildId: string): MinecraftGuildSettings | undefined {
	return db.prepare('SELECT * FROM minecraft_guild_settings WHERE guild_id = ?').get(guildId) as
		MinecraftGuildSettings | undefined;
}

/** `null` leaves bridges to the server's owner alone. */
export function setAllowedRole(guildId: string, roleId: string | null): void {
	db.prepare(
		`INSERT INTO minecraft_guild_settings (guild_id, allowed_role_id) VALUES (?, ?)
		 ON CONFLICT(guild_id) DO UPDATE SET allowed_role_id = excluded.allowed_role_id`,
	).run(guildId, roleId);
}

// --- Bridges ---
export function getBridge(id: string): MinecraftBridge | undefined {
	return db.prepare('SELECT * FROM minecraft_bridges WHERE id = ?').get(id) as MinecraftBridge | undefined;
}

export function getGuildBridges(guildId: string): MinecraftBridge[] {
	return db
		.prepare('SELECT * FROM minecraft_bridges WHERE guild_id = ? ORDER BY created_at, id')
		.all(guildId) as MinecraftBridge[];
}

/** Saves a newly paired bridge under a new random id, with the default prefix, colour and pictures. */
export function createBridge(bridge: {
	guildId: string;
	chat: BridgeWebhook;
	alerts: BridgeWebhook;
	keys: BridgeKeys;
	serverName: string;
	now: number;
}): MinecraftBridge {
	const id = randomBytes(16).toString('base64url');
	db.prepare(
		`INSERT INTO minecraft_bridges (
			id, guild_id,
			chat_channel_id, chat_webhook_id, chat_webhook_token,
			alerts_channel_id, alerts_webhook_id, alerts_webhook_token,
			request_key, response_key, server_name, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		bridge.guildId,
		bridge.chat.channelId,
		bridge.chat.webhookId,
		bridge.chat.token,
		bridge.alerts.channelId,
		bridge.alerts.webhookId,
		bridge.alerts.token,
		bridge.keys.request,
		bridge.keys.response,
		bridge.serverName,
		bridge.now,
	);
	return getBridge(id)!;
}

/**
 * Changes how the bridge shows in game and in Discord, keeping what isn't
 * given. `defaultPicture: null` hands the default back to the helper's
 * config. Returns the updated bridge, or undefined if it's gone.
 */
export function updateBridgeSettings(
	id: string,
	updates: { serverName?: string; prefix?: string; colour?: string; defaultPicture?: DefaultPicture | null },
): MinecraftBridge | undefined {
	const existing = getBridge(id);
	if (!existing) return undefined;
	db.prepare(
		'UPDATE minecraft_bridges SET server_name = ?, prefix = ?, colour = ?, default_picture = ? WHERE id = ?',
	).run(
		updates.serverName ?? existing.server_name,
		updates.prefix ?? existing.prefix,
		updates.colour ?? existing.colour,
		updates.defaultPicture === undefined ? existing.default_picture : updates.defaultPicture,
		id,
	);
	return getBridge(id);
}

/**
 * Replaces a bridge's webhooks or keys, keeping what isn't given: new
 * channels, or regenerating, which replaces all three at once so a leaked
 * config stops working in one step. False if the bridge is gone.
 */
export function replaceBridgeConnection(
	id: string,
	replacement: { chat?: BridgeWebhook; alerts?: BridgeWebhook; keys?: BridgeKeys },
): boolean {
	const existing = getBridge(id);
	if (!existing) return false;
	const chat = replacement.chat ?? {
		channelId: existing.chat_channel_id,
		webhookId: existing.chat_webhook_id,
		token: existing.chat_webhook_token,
	};
	const alerts = replacement.alerts ?? {
		channelId: existing.alerts_channel_id,
		webhookId: existing.alerts_webhook_id,
		token: existing.alerts_webhook_token,
	};
	const keys = replacement.keys ?? { request: existing.request_key, response: existing.response_key };
	return (
		db
			.prepare(
				`UPDATE minecraft_bridges SET
					chat_channel_id = ?, chat_webhook_id = ?, chat_webhook_token = ?,
					alerts_channel_id = ?, alerts_webhook_id = ?, alerts_webhook_token = ?,
					request_key = ?, response_key = ?
				 WHERE id = ?`,
			)
			.run(
				chat.channelId,
				chat.webhookId,
				chat.token,
				alerts.channelId,
				alerts.webhookId,
				alerts.token,
				keys.request,
				keys.response,
				id,
			).changes > 0
	);
}

/** Records that the opt-in announcement was posted in this channel (decision 0006). */
export function markBridgeAnnounced(id: string, channelId: string): void {
	db.prepare('UPDATE minecraft_bridges SET announced_channel_id = ? WHERE id = ?').run(channelId, id);
}

/**
 * Records the newest message relayed, for catching up after a restart
 * (decision 0010). It never moves back, so a message relayed late can't
 * make the catch-up relay the ones after it a second time. Ids are compared
 * as snowflakes: a longer id is a later one, and ids of one length compare
 * as text. So `messageId` must be a Discord message id: anything else would
 * compare wrongly and could block every later update.
 */
export function recordRelayedMessage(id: string, messageId: string): void {
	db.prepare(
		`UPDATE minecraft_bridges SET last_relayed_message_id = @messageId
		 WHERE id = @id AND (
			last_relayed_message_id IS NULL
			OR length(last_relayed_message_id) < length(@messageId)
			OR (length(last_relayed_message_id) = length(@messageId) AND last_relayed_message_id < @messageId)
		 )`,
	).run({ messageId, id });
}

/** Deletes a bridge with its pictures and links. The caller deletes its webhooks on Discord. */
export const deleteBridge = db.transaction((id: string): void => {
	db.prepare('DELETE FROM minecraft_links WHERE bridge_id = ?').run(id);
	db.prepare('DELETE FROM minecraft_bridge_pictures WHERE bridge_id = ?').run(id);
	db.prepare('DELETE FROM minecraft_bridges WHERE id = ?').run(id);
});

/**
 * Deletes everything Minecraft a server has here, for when the bot leaves it:
 * its bridges (so their keys stop working), pictures, links and settings.
 */
export const deleteGuildMinecraftData = db.transaction((guildId: string): void => {
	const bridges = `SELECT id FROM minecraft_bridges WHERE guild_id = ?`;
	db.prepare(`DELETE FROM minecraft_links WHERE bridge_id IN (${bridges})`).run(guildId);
	db.prepare(`DELETE FROM minecraft_bridge_pictures WHERE bridge_id IN (${bridges})`).run(guildId);
	db.prepare('DELETE FROM minecraft_bridges WHERE guild_id = ?').run(guildId);
	db.prepare('DELETE FROM minecraft_guild_settings WHERE guild_id = ?').run(guildId);
});

// --- Pictures set by the bridge's managers ---
export function getPlayerPictures(bridgeId: string): MinecraftBridgePicture[] {
	return db
		.prepare('SELECT * FROM minecraft_bridge_pictures WHERE bridge_id = ? ORDER BY name_key')
		.all(bridgeId) as MinecraftBridgePicture[];
}

/** `null` hands the player back to the helper's config. */
export function setPlayerPicture(bridgeId: string, name: string, picture: PlayerPicture | null): void {
	if (picture === null) {
		db.prepare('DELETE FROM minecraft_bridge_pictures WHERE bridge_id = ? AND name_key = ?').run(
			bridgeId,
			playerNameKey(name),
		);
		return;
	}
	db.prepare(
		`INSERT INTO minecraft_bridge_pictures (bridge_id, name, name_key, picture) VALUES (?, ?, ?, ?)
		 ON CONFLICT(bridge_id, name_key) DO UPDATE SET name = excluded.name, picture = excluded.picture`,
	).run(bridgeId, name, playerNameKey(name), picture);
}

// --- Links (decision 0007) ---
export function getLink(bridgeId: string, name: string): MinecraftLink | undefined {
	return db
		.prepare('SELECT * FROM minecraft_links WHERE bridge_id = ? AND name_key = ?')
		.get(bridgeId, playerNameKey(name)) as MinecraftLink | undefined;
}

export function getBridgeLinks(bridgeId: string): MinecraftLink[] {
	return db
		.prepare('SELECT * FROM minecraft_links WHERE bridge_id = ? ORDER BY name_key')
		.all(bridgeId) as MinecraftLink[];
}

/** A member's links on a server's bridges, for their own page. */
export function getMemberLinks(guildId: string, userId: string): MinecraftLink[] {
	return db
		.prepare(
			`SELECT l.* FROM minecraft_links l
			 JOIN minecraft_bridges b ON b.id = l.bridge_id
			 WHERE b.guild_id = ? AND l.user_id = ?
			 ORDER BY b.created_at, b.id, l.name_key`,
		)
		.all(guildId, userId) as MinecraftLink[];
}

/**
 * Saves a link proven by a code typed in game. A name has one link, so this
 * replaces the name's earlier one. Its picture is kept only when the same
 * member linked the same account again, so one player's choice never
 * passes to another.
 */
export function saveLink(link: {
	bridgeId: string;
	name: string;
	userId: string;
	uuid: string;
	now: number;
}): MinecraftLink {
	db.prepare(
		`INSERT INTO minecraft_links (bridge_id, name, name_key, user_id, uuid, linked_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(bridge_id, name_key) DO UPDATE SET
			name = excluded.name,
			picture = CASE WHEN user_id = excluded.user_id AND uuid = excluded.uuid THEN picture ELSE 'default' END,
			user_id = excluded.user_id,
			uuid = excluded.uuid,
			linked_at = excluded.linked_at`,
	).run(link.bridgeId, link.name, playerNameKey(link.name), link.userId, link.uuid, link.now);
	return getLink(link.bridgeId, link.name)!;
}

/** Only the member who linked the name can choose its picture. False if they have no such link. */
export function setLinkPicture(bridgeId: string, name: string, userId: string, picture: LinkPicture): boolean {
	return (
		db
			.prepare('UPDATE minecraft_links SET picture = ? WHERE bridge_id = ? AND name_key = ? AND user_id = ?')
			.run(picture, bridgeId, playerNameKey(name), userId).changes > 0
	);
}

export function deleteLink(bridgeId: string, name: string): boolean {
	return (
		db.prepare('DELETE FROM minecraft_links WHERE bridge_id = ? AND name_key = ?').run(bridgeId, playerNameKey(name))
			.changes > 0
	);
}

/** Deletes a member's links on a server's bridges, for when they've left it. Returns how many. */
export function deleteMemberLinks(guildId: string, userId: string): number {
	return db
		.prepare(
			`DELETE FROM minecraft_links
			 WHERE user_id = ? AND bridge_id IN (SELECT id FROM minecraft_bridges WHERE guild_id = ?)`,
		)
		.run(userId, guildId).changes;
}
