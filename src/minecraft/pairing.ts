import { ChannelType, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { serverNameProblem } from './bridge/config.ts';
import { deriveKeys, newBridgeSecret } from './bridge/seal.ts';
import {
	createBridge,
	deleteBridge,
	getBridge,
	getGuildBridges,
	getMinecraftGuildSettings,
	MAX_BRIDGES_PER_GUILD,
	replaceBridgeConnection,
	type BridgeWebhook,
	type MinecraftBridge,
} from './storage.ts';

// Pairing a Minecraft server's helper with the bot (plan A8, decision 0006):
// the bridge's two webhooks, its secret, and the config to download. The
// dashboard's pages call these (A8f).

interface Permissions {
	has(permission: bigint): boolean;
}

/** What pairing uses of a member; discord.js's GuildMember fits it. */
export interface PairingMember {
	id: string;
	roles: { cache: { has(roleId: string): boolean } };
	isCommunicationDisabled(): boolean;
}

/**
 * What pairing uses of a channel; discord.js's text and announcement channels
 * fit it, with GuildMember as M (generic, as discord.js's permissionsFor
 * takes a GuildMember or a Role, which no narrower member type fits).
 */
export interface PairingChannel<M extends PairingMember = PairingMember> {
	id: string;
	type: ChannelType;
	permissionsFor(member: M): Permissions | null;
	createWebhook(options: { name: string; reason?: string }): Promise<{ id: string; token: string | null }>;
}

/**
 * Any channel in a server: only text and announcement channels have all of
 * PairingChannel. Written out rather than `Partial<PairingChannel>`, which
 * would turn the methods into properties that discord.js's overloads don't fit.
 */
interface GuildChannel<M extends PairingMember> {
	id: string;
	type: ChannelType;
	permissionsFor?(member: M): Permissions | null;
	createWebhook?(options: { name: string; reason?: string }): Promise<{ id: string; token: string | null }>;
}

/** What pairing uses of a server; discord.js's Guild fits it, with GuildMember as M. */
export interface PairingGuild<M extends PairingMember = PairingMember> {
	id: string;
	ownerId: string;
	members: { me: M | null };
	channels: { cache: { get(id: string): GuildChannel<M> | undefined } };
	client: { deleteWebhook(id: string, options?: { token?: string; reason?: string }): Promise<void> };
}

/** The `mcbridge.json` pairing hands over, with `logPath` left for the host to fill in. */
export interface HelperConfig {
	serverName: string;
	logPath: '';
	webhooks: { chat: string; alerts: string };
	bot: { url: string; bridge: string; secret: string };
}

export type BotPermission = 'ViewChannel' | 'ManageWebhooks' | 'ReadMessageHistory';

export type PairingRefusal =
	| { reason: 'not-allowed' }
	| { reason: 'bad-name'; problem: string }
	| { reason: 'bridge-limit'; max: number }
	| { reason: 'unknown-bridge' }
	/** Its channels changed while new webhooks were made for the old ones: try again. */
	| { reason: 'bridge-changed' }
	/** Gone, or not a text or announcement channel. */
	| { reason: 'unusable-channel'; channelId: string }
	| { reason: 'member-cant-manage-channel'; channelId: string }
	| { reason: 'bot-missing-permissions'; channelId: string; missing: BotPermission[] }
	| { reason: 'webhook-limit'; channelId: string; scope: 'channel' | 'server' }
	/** Discord or the database failed; logged, and nothing is left behind. */
	| { reason: 'error' };

export type Paired = { ok: true; bridge: MinecraftBridge; config: HelperConfig };
export type Regenerated = Paired & {
	/** Old webhooks Discord wouldn't delete: they still post, so the manager deletes them by hand. */
	undeletedWebhooks: { channelId: string; webhookId: string }[];
};

// Fixed rather than the server's name: Discord holds a webhook's name to its
// nickname rules, and the helper names each post itself anyway.
const WEBHOOK_NAMES = { chat: 'Minecraft chat', alerts: 'Minecraft alerts' } as const;

const BOT_PERMISSIONS: Record<BotPermission, bigint> = {
	ViewChannel: PermissionFlagsBits.ViewChannel,
	ManageWebhooks: PermissionFlagsBits.ManageWebhooks,
	ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
};

/**
 * The server's owner, or a member with the role they allowed (plan A8,
 * "Who counts"), not Manage Server. A member in timeout is refused, which
 * discord.js's permissions ignore. The member should be fetched fresh, as
 * the bot isn't told of role changes (dashboard/access.ts).
 */
export function canManageBridges(guild: { id: string; ownerId: string }, member: PairingMember): boolean {
	if (member.isCommunicationDisabled()) return false;
	if (member.id === guild.ownerId) return true;
	const role = getMinecraftGuildSettings(guild.id)?.allowed_role_id;
	return role != null && member.roles.cache.has(role);
}

/**
 * Pairs a new bridge: checks everything first, so a refusal leaves nothing
 * behind, then makes the two webhooks and a secret. Only the keys derived
 * from the secret are stored; the secret is in the returned config, shown
 * once.
 */
export async function pairBridge<M extends PairingMember>(request: {
	guild: PairingGuild<M>;
	member: M;
	chatChannelId: string;
	alertsChannelId: string;
	serverName: string;
	/** The dashboard's public origin (DASHBOARD_URL). */
	dashboardUrl: string;
	now?: number;
}): Promise<Paired | ({ ok: false } & PairingRefusal)> {
	const { guild, member, serverName } = request;
	if (!canManageBridges(guild, member)) return { ok: false, reason: 'not-allowed' };
	const problem = serverNameProblem(serverName);
	if (problem) return { ok: false, reason: 'bad-name', problem };
	// Each bridge takes two of a channel's 15 webhooks and the server's 1000.
	if (getGuildBridges(guild.id).length >= MAX_BRIDGES_PER_GUILD) {
		return { ok: false, reason: 'bridge-limit', max: MAX_BRIDGES_PER_GUILD };
	}

	const channels = checkChannels(guild, member, request.chatChannelId, request.alertsChannelId);
	if ('reason' in channels) return { ok: false, ...channels };

	const reason = `Minecraft bridge "${serverName}" paired by member ${member.id}`;
	const webhooks = await createWebhooks(guild, channels, reason);
	if ('reason' in webhooks) return { ok: false, ...webhooks };

	const secret = newBridgeSecret();
	let bridge: MinecraftBridge;
	try {
		bridge = createBridge({
			guildId: guild.id,
			chat: webhooks.chat,
			alerts: webhooks.alerts,
			keys: deriveKeys(secret),
			serverName,
			now: request.now ?? Date.now(),
		});
	} catch (error) {
		// Unrecorded, the new webhooks would post for anyone who saw their URLs.
		console.error(`Minecraft pairing: couldn't save the bridge in ${guild.id}:`, error);
		await deleteWebhooks(guild, webhooks, reason);
		return { ok: false, reason: 'error' };
	}
	return { ok: true, bridge, config: helperConfig(bridge, secret, request.dashboardUrl) };
}

/**
 * Replaces a bridge's secret and both webhooks at once and deletes the old
 * webhooks, so a leaked config stops working in one step. A helper still
 * running with the old config is refused at its next request (401).
 */
export async function regenerateBridge<M extends PairingMember>(request: {
	guild: PairingGuild<M>;
	member: M;
	bridgeId: string;
	dashboardUrl: string;
}): Promise<Regenerated | ({ ok: false } & PairingRefusal)> {
	const { guild, member, bridgeId } = request;
	if (!canManageBridges(guild, member)) return { ok: false, reason: 'not-allowed' };
	const bridge = getBridge(bridgeId);
	// Another server's bridge is as unknown as one that doesn't exist.
	if (!bridge || bridge.guild_id !== guild.id) return { ok: false, reason: 'unknown-bridge' };

	// Checked again, though the channels are the bridge's own: the config holds
	// webhook URLs, so a manager who can't manage a channel's webhooks mustn't
	// get one for it this way either.
	const channels = checkChannels(guild, member, bridge.chat_channel_id, bridge.alerts_channel_id);
	if ('reason' in channels) return { ok: false, ...channels };

	const reason = `Minecraft bridge "${bridge.server_name}" regenerated by member ${member.id}`;
	const webhooks = await createWebhooks(guild, channels, reason);
	if ('reason' in webhooks) return { ok: false, ...webhooks };

	const secret = newBridgeSecret();
	const keys = deriveKeys(secret);
	// Read and replaced with no await between, so the webhooks deleted below are
	// the ones this replaced. Two regenerations at once then each delete what
	// the other saved before them, and no live webhook is left unrecorded; the
	// later one's config is the one that works.
	const replaced = getBridge(bridgeId);
	if (!replaced) {
		await deleteWebhooks(guild, webhooks, reason);
		return { ok: false, reason: 'unknown-bridge' };
	}
	// Moved meanwhile: saving would put the bridge back on the old channels.
	if (replaced.chat_channel_id !== bridge.chat_channel_id || replaced.alerts_channel_id !== bridge.alerts_channel_id) {
		await deleteWebhooks(guild, webhooks, reason);
		return { ok: false, reason: 'bridge-changed' };
	}
	try {
		replaceBridgeConnection(bridgeId, { ...webhooks, keys });
	} catch (error) {
		console.error(`Minecraft pairing: couldn't save bridge ${bridgeId}'s new webhooks and keys:`, error);
		await deleteWebhooks(guild, webhooks, reason);
		return { ok: false, reason: 'error' };
	}
	// What this call saved, not read again after the deletes below: a later
	// regeneration or removal mustn't change what this one returns.
	const saved: MinecraftBridge = {
		...replaced,
		chat_webhook_id: webhooks.chat.webhookId,
		chat_webhook_token: webhooks.chat.token,
		alerts_webhook_id: webhooks.alerts.webhookId,
		alerts_webhook_token: webhooks.alerts.token,
		request_key: keys.request,
		response_key: keys.response,
	};

	const undeletedWebhooks: Regenerated['undeletedWebhooks'] = [];
	for (const old of [
		{ channelId: replaced.chat_channel_id, webhookId: replaced.chat_webhook_id, token: replaced.chat_webhook_token },
		{
			channelId: replaced.alerts_channel_id,
			webhookId: replaced.alerts_webhook_id,
			token: replaced.alerts_webhook_token,
		},
	]) {
		if (!(await deleteWebhook(guild, old, reason))) {
			undeletedWebhooks.push({ channelId: old.channelId, webhookId: old.webhookId });
		}
	}
	return { ok: true, bridge: saved, config: helperConfig(saved, secret, request.dashboardUrl), undeletedWebhooks };
}

export type Removed = {
	ok: true;
	bridge: MinecraftBridge;
	/** Webhooks Discord wouldn't delete: they still post, so the manager deletes them by hand. */
	undeletedWebhooks: { channelId: string; webhookId: string }[];
};

/**
 * Removes a bridge with its pictures and links, then deletes its webhooks.
 * The row goes first, so its keys stop working and its chat stops being
 * relayed even if Discord won't delete a webhook. Unlike regenerating, it
 * doesn't check the member's rights in the channels: they get no webhook URL
 * from it, and a manager must be able to remove a bridge whose channel they
 * can no longer see.
 */
export async function removeBridge<M extends PairingMember>(request: {
	guild: Pick<PairingGuild<M>, 'id' | 'ownerId' | 'client'>;
	member: M;
	bridgeId: string;
}): Promise<Removed | { ok: false; reason: 'not-allowed' | 'unknown-bridge' | 'error' }> {
	const { guild, member, bridgeId } = request;
	if (!canManageBridges(guild, member)) return { ok: false, reason: 'not-allowed' };
	const bridge = getBridge(bridgeId);
	if (!bridge || bridge.guild_id !== guild.id) return { ok: false, reason: 'unknown-bridge' };
	try {
		deleteBridge(bridgeId);
	} catch (error) {
		console.error(`Minecraft pairing: couldn't remove bridge ${bridgeId}:`, error);
		return { ok: false, reason: 'error' };
	}

	const reason = `Minecraft bridge "${bridge.server_name}" removed by member ${member.id}`;
	const undeletedWebhooks: Removed['undeletedWebhooks'] = [];
	for (const webhook of [
		{ channelId: bridge.chat_channel_id, webhookId: bridge.chat_webhook_id, token: bridge.chat_webhook_token },
		{ channelId: bridge.alerts_channel_id, webhookId: bridge.alerts_webhook_id, token: bridge.alerts_webhook_token },
	]) {
		if (!(await deleteWebhook(guild, webhook, reason))) {
			undeletedWebhooks.push({ channelId: webhook.channelId, webhookId: webhook.webhookId });
		}
	}
	return { ok: true, bridge, undeletedWebhooks };
}

export function helperConfig(bridge: MinecraftBridge, secret: string, dashboardUrl: string): HelperConfig {
	return {
		serverName: bridge.server_name,
		logPath: '',
		webhooks: {
			chat: webhookUrl(bridge.chat_webhook_id, bridge.chat_webhook_token),
			alerts: webhookUrl(bridge.alerts_webhook_id, bridge.alerts_webhook_token),
		},
		// With the slash, so the helper can resolve `connect` and `poll` against it.
		bot: { url: new URL('/minecraft/', dashboardUrl).href, bridge: bridge.id, secret },
	};
}

function webhookUrl(id: string, token: string): string {
	return `https://discord.com/api/webhooks/${id}/${token}`;
}

type ChannelPair = { chat: PairingChannel<never>; alerts: PairingChannel<never> };

function checkChannels<M extends PairingMember>(
	guild: PairingGuild<M>,
	member: M,
	chatId: string,
	alertsId: string,
): ChannelPair | PairingRefusal {
	const me = guild.members.me;
	if (!me) return { reason: 'error' };
	const chat = checkChannel(guild, member, me, chatId, ['ViewChannel', 'ManageWebhooks', 'ReadMessageHistory']);
	if ('reason' in chat) return chat;
	// Reading history is for catching up the chat after a restart (decision 0010).
	const alerts = checkChannel(guild, member, me, alertsId, ['ViewChannel', 'ManageWebhooks']);
	if ('reason' in alerts) return alerts;
	return { chat, alerts };
}

function checkChannel<M extends PairingMember>(
	guild: PairingGuild<M>,
	member: M,
	me: M,
	channelId: string,
	needed: BotPermission[],
): PairingChannel<M> | PairingRefusal {
	const channel = guild.channels.cache.get(channelId);
	// Forum channels take webhooks only into a thread, which the helper doesn't name.
	if (
		!channel ||
		(channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) ||
		!channel.permissionsFor ||
		!channel.createWebhook
	) {
		return { reason: 'unusable-channel', channelId };
	}
	const usable = channel as PairingChannel<M>;
	// So the relay can't be aimed at a channel the member can't see, nor its
	// webhook URLs handed to someone who couldn't make one there.
	const theirs = usable.permissionsFor(member);
	if (!theirs?.has(PermissionFlagsBits.ViewChannel) || !theirs.has(PermissionFlagsBits.ManageWebhooks)) {
		return { reason: 'member-cant-manage-channel', channelId };
	}
	const ours = usable.permissionsFor(me);
	const missing = needed.filter((name) => !ours?.has(BOT_PERMISSIONS[name]));
	if (missing.length) return { reason: 'bot-missing-permissions', channelId, missing };
	return usable;
}

async function createWebhooks(
	guild: Pick<PairingGuild, 'client'>,
	channels: ChannelPair,
	reason: string,
): Promise<{ chat: BridgeWebhook; alerts: BridgeWebhook } | PairingRefusal> {
	const chat = await createWebhook(guild, channels.chat, WEBHOOK_NAMES.chat, reason);
	if ('reason' in chat) return chat;
	const alerts = await createWebhook(guild, channels.alerts, WEBHOOK_NAMES.alerts, reason);
	if ('reason' in alerts) {
		await deleteWebhook(guild, chat, reason);
		return alerts;
	}
	return { chat, alerts };
}

async function createWebhook(
	guild: Pick<PairingGuild, 'client'>,
	channel: PairingChannel<never>,
	name: string,
	reason: string,
): Promise<BridgeWebhook | PairingRefusal> {
	let webhook: { id: string; token: string | null };
	try {
		webhook = await channel.createWebhook({ name, reason });
	} catch (error) {
		return refusalFor(error, channel.id);
	}
	if (!webhook.token) {
		// Discord returns the token for a webhook the bot made; without it the
		// helper couldn't post, so it isn't left behind.
		console.error(`Minecraft pairing: webhook ${webhook.id} in ${channel.id} came back without a token`);
		await deleteWebhook(guild, { webhookId: webhook.id }, reason);
		return { reason: 'error' };
	}
	return { channelId: channel.id, webhookId: webhook.id, token: webhook.token };
}

function refusalFor(error: unknown, channelId: string): PairingRefusal {
	switch ((error as { code?: unknown }).code) {
		case RESTJSONErrorCodes.MissingPermissions:
			// Checked just before, so a permission changed in between.
			return { reason: 'bot-missing-permissions', channelId, missing: ['ManageWebhooks'] };
		case RESTJSONErrorCodes.MissingAccess:
			return { reason: 'bot-missing-permissions', channelId, missing: ['ViewChannel'] };
		case RESTJSONErrorCodes.MaximumNumberOfWebhooksReached:
			return { reason: 'webhook-limit', channelId, scope: 'channel' };
		case RESTJSONErrorCodes.MaximumNumberOfWebhooksPerGuildReached:
			return { reason: 'webhook-limit', channelId, scope: 'server' };
		case RESTJSONErrorCodes.UnknownChannel:
			return { reason: 'unusable-channel', channelId };
		default:
			console.error(`Minecraft pairing: couldn't make a webhook in ${channelId}:`, error);
			return { reason: 'error' };
	}
}

async function deleteWebhooks(
	guild: Pick<PairingGuild, 'client'>,
	webhooks: { chat: BridgeWebhook; alerts: BridgeWebhook },
	reason: string,
): Promise<void> {
	await deleteWebhook(guild, webhooks.chat, reason);
	await deleteWebhook(guild, webhooks.alerts, reason);
}

/**
 * True once the webhook is gone, including when it already was. With its
 * token, deleting needs no permission, so it works after the bot has lost
 * Manage Webhooks; the id is logged on failure, as the webhook still posts.
 */
async function deleteWebhook(
	guild: Pick<PairingGuild, 'client'>,
	webhook: { webhookId: string; token?: string },
	reason: string,
): Promise<boolean> {
	try {
		await guild.client.deleteWebhook(webhook.webhookId, { ...(webhook.token && { token: webhook.token }), reason });
		return true;
	} catch (error) {
		if ((error as { code?: unknown }).code === RESTJSONErrorCodes.UnknownWebhook) return true;
		console.error(`Minecraft pairing: couldn't delete webhook ${webhook.webhookId} (${describeFailure(error)})`);
		return false;
	}
}

// Never the error itself: deleting with the token puts it in the request's
// URL, which @discordjs/rest's errors carry, and the webhook still posts.
function describeFailure(error: unknown): string {
	const { status, code, message } = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
	return [status, code, message].filter((part) => typeof part === 'number' || typeof part === 'string').join(' ');
}
