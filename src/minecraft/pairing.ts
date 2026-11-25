import { ChannelType, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { serverNameProblem } from './bridge/config.ts';
import { deriveKeys, newBridgeSecret } from './bridge/seal.ts';
import {
	createBridge,
	getBridge,
	getMinecraftGuildSettings,
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
	client: { deleteWebhook(id: string, options?: { reason?: string }): Promise<void> };
}

/** The `mcbridge.json` pairing hands over, with `logPath` left for the host to fill in. */
export interface HelperConfig {
	serverName: string;
	logPath: '';
	webhooks: { chat: string; alerts: string };
	bot: { url: string; secret: string };
}

export type BotPermission = 'ViewChannel' | 'ManageWebhooks' | 'ReadMessageHistory';

export type PairingRefusal =
	| { reason: 'not-allowed' }
	| { reason: 'bad-name'; problem: string }
	| { reason: 'unknown-bridge' }
	/** Gone, or not a text or announcement channel. */
	| { reason: 'unusable-channel'; channelId: string }
	| { reason: 'member-cant-manage-channel'; channelId: string }
	| { reason: 'bot-missing-permissions'; channelId: string; missing: BotPermission[] }
	| { reason: 'webhook-limit'; channelId: string; scope: 'channel' | 'server' }
	| { reason: 'discord-error' };

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

	const channels = checkChannels(guild, member, request.chatChannelId, request.alertsChannelId);
	if ('reason' in channels) return { ok: false, ...channels };

	const reason = `Minecraft bridge "${serverName}" paired by member ${member.id}`;
	const webhooks = await createWebhooks(guild, channels, reason);
	if ('reason' in webhooks) return { ok: false, ...webhooks };

	const secret = newBridgeSecret();
	const bridge = createBridge({
		guildId: guild.id,
		chat: webhooks.chat,
		alerts: webhooks.alerts,
		keys: deriveKeys(secret),
		serverName,
		now: request.now ?? Date.now(),
	});
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
	// Read and replaced with no await between, so the webhooks deleted below are
	// the ones this replaced. Two regenerations at once then each delete what
	// the other saved before them, and no live webhook is left unrecorded.
	const replaced = getBridge(bridgeId);
	if (!replaced || !replaceBridgeConnection(bridgeId, { ...webhooks, keys: deriveKeys(secret) })) {
		await deleteWebhook(guild, webhooks.chat.webhookId, reason);
		await deleteWebhook(guild, webhooks.alerts.webhookId, reason);
		return { ok: false, reason: 'unknown-bridge' };
	}

	const undeletedWebhooks: Regenerated['undeletedWebhooks'] = [];
	for (const [channelId, webhookId] of [
		[replaced.chat_channel_id, replaced.chat_webhook_id],
		[replaced.alerts_channel_id, replaced.alerts_webhook_id],
	] as const) {
		if (!(await deleteWebhook(guild, webhookId, reason))) undeletedWebhooks.push({ channelId, webhookId });
	}
	const updated = getBridge(bridgeId)!;
	return { ok: true, bridge: updated, config: helperConfig(updated, secret, request.dashboardUrl), undeletedWebhooks };
}

export function helperConfig(bridge: MinecraftBridge, secret: string, dashboardUrl: string): HelperConfig {
	return {
		serverName: bridge.server_name,
		logPath: '',
		webhooks: {
			chat: webhookUrl(bridge.chat_webhook_id, bridge.chat_webhook_token),
			alerts: webhookUrl(bridge.alerts_webhook_id, bridge.alerts_webhook_token),
		},
		bot: { url: new URL('/minecraft', dashboardUrl).href, secret },
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
	if (!me) return { reason: 'discord-error' };
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
		await deleteWebhook(guild, chat.webhookId, reason);
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
		await deleteWebhook(guild, webhook.id, reason);
		return { reason: 'discord-error' };
	}
	return { channelId: channel.id, webhookId: webhook.id, token: webhook.token };
}

function refusalFor(error: unknown, channelId: string): PairingRefusal {
	switch ((error as { code?: unknown }).code) {
		case RESTJSONErrorCodes.MissingPermissions:
			// Checked just before, so a permission changed in between.
			return { reason: 'bot-missing-permissions', channelId, missing: ['ManageWebhooks'] };
		case RESTJSONErrorCodes.MaximumNumberOfWebhooksReached:
			return { reason: 'webhook-limit', channelId, scope: 'channel' };
		case RESTJSONErrorCodes.MaximumNumberOfWebhooksPerGuildReached:
			return { reason: 'webhook-limit', channelId, scope: 'server' };
		case RESTJSONErrorCodes.UnknownChannel:
			return { reason: 'unusable-channel', channelId };
		default:
			console.error(`Minecraft pairing: couldn't make a webhook in ${channelId}:`, error);
			return { reason: 'discord-error' };
	}
}

/** True once the webhook is gone, including when it already was. */
async function deleteWebhook(guild: Pick<PairingGuild, 'client'>, webhookId: string, reason: string): Promise<boolean> {
	try {
		await guild.client.deleteWebhook(webhookId, { reason });
		return true;
	} catch (error) {
		if ((error as { code?: unknown }).code === RESTJSONErrorCodes.UnknownWebhook) return true;
		console.error(`Minecraft pairing: couldn't delete webhook ${webhookId}:`, error);
		return false;
	}
}
