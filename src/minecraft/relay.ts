import { MessageType, type Guild, type Message, type User } from 'discord.js';
import { createRateLimiter } from '../dashboard/rateLimit.ts';
import type { HelperHub } from './helperHub.ts';
import { getGuildBridges, recordRelayedMessage } from './storage.ts';

// Discord to Minecraft (the plan's A8, "The relay"; decision 0006): a message
// in a bridge's chat channel goes to its helper as plain text and the
// sender's name, and the helper builds the `tellraw` command
// (bridge/toMinecraft.ts), cleaning and cutting the text there. Chat is
// passed on in memory only: never stored or logged.

/** More than this many in a one-second window into one bridge's game are dropped. */
export const RELAYED_PER_SECOND = 5;

/** A chat message for the helper, as it goes into its poll's answer. */
export interface RelayedChat {
	kind: 'chat';
	name: string;
	text: string;
}

// Date.now read at each call, so fake timers in tests move it.
const relayed = createRateLimiter(RELAYED_PER_SECOND, 1000, () => Date.now());

/**
 * Queues the message for every bridge whose chat channel it was posted in,
 * once the relay has been announced there (decision 0006: nothing is relayed
 * until it is), and records it as the last one relayed (decision 0010).
 */
export function relayMessage(message: Message, hub: HelperHub): void {
	if (!message.inGuild() || !isMemberChat(message)) return;
	const bridges = getGuildBridges(message.guildId).filter(
		(bridge) => bridge.chat_channel_id === message.channelId && bridge.announced_channel_id === message.channelId,
	);
	if (bridges.length === 0) return;
	const chat = chatFor(message);
	if (!chat) return;
	for (const bridge of bridges) {
		// The catch-up may have relayed it already, fetched before the gateway brought it.
		if (!isLaterMessage(message.id, bridge.last_relayed_message_id)) continue;
		const holding = held.get(bridge.id);
		if (holding) {
			holding.firstLiveId ??= message.id;
			if (holding.messages.length < MAX_HELD_LIVE) holding.messages.push({ id: message.id, chat });
			continue;
		}
		send(bridge.id, message.id, chat, hub);
	}
}

function send(bridgeId: string, messageId: string, chat: RelayedChat, hub: HelperHub): void {
	if (relayed.take(bridgeId) > 0) return;
	if (hub.deliver(bridgeId, chat)) recordRelayedMessage(bridgeId, messageId);
}

/** Whether `id` comes after `last`, as snowflakes; anything does when nothing was relayed yet. */
export function isLaterMessage(id: string, last: string | null): boolean {
	return last === null || BigInt(id) > BigInt(last);
}

// While a bridge catches up after a restart (decision 0010), its live
// messages wait, so the caught-up ones reach the game first, and the first
// of them marks where the catch-up stops. A catch-up takes a REST call or
// two; at the relay's 5 a second, more than this would be dropped anyway.
const MAX_HELD_LIVE = 50;
const held = new Map<string, { firstLiveId: string | null; messages: { id: string; chat: RelayedChat }[] }>();

/** Holds the bridge's live messages until releaseLiveMessages. */
export function holdLiveMessages(bridgeId: string): void {
	held.set(bridgeId, { firstLiveId: null, messages: [] });
}

/** The first live message held for the bridge since holdLiveMessages, if any. */
export function firstLiveMessageId(bridgeId: string): string | null {
	return held.get(bridgeId)?.firstLiveId ?? null;
}

/** Sends the bridge's held live messages in order, as relayMessage would have; `hub` null drops them (shutdown). */
export function releaseLiveMessages(bridgeId: string, hub: HelperHub | null): void {
	const holding = held.get(bridgeId);
	held.delete(bridgeId);
	if (!holding || !hub) return;
	for (const { id, chat } of holding.messages) send(bridgeId, id, chat, hub);
}

// Webhooks are left out, the bridge's own posts of game chat among them, or
// each line would echo back into the game; so are apps and Discord's own
// messages (pins, joins, boosts, or any from its system user), and a slash
// command's reply.
export function isMemberChat(message: Message): boolean {
	return (
		(message.type === MessageType.Default || message.type === MessageType.Reply) &&
		message.webhookId === null &&
		!message.author.bot &&
		!message.author.system
	);
}

/**
 * The message as the helper shows it: mentions and custom emoji as names
 * (discord.js's cleanContent, from its cache), `[image]`, `[file]` and
 * `[sticker]` for what can't be shown in game, and `(reply to Name)`. Null
 * when nothing is left to show, as for a poll or a forwarded message.
 */
export function chatFor(message: Message<true>): RelayedChat | null {
	const parts: string[] = [];
	if (message.cleanContent) parts.push(message.cleanContent);
	for (const attachment of message.attachments.values()) {
		parts.push(attachment.contentType?.startsWith('image/') ? '[image]' : '[file]');
	}
	for (let i = 0; i < message.stickers.size; i++) parts.push('[sticker]');
	if (parts.length === 0) return null;

	// A reply to a relayed game message names the player, as the webhook
	// that posted it carries their name.
	const replied = message.type === MessageType.Reply ? message.mentions.repliedUser : null;
	if (replied) parts.unshift(`(reply to ${nameIn(message.guild, replied)})`);
	return { kind: 'chat', name: message.member?.displayName ?? message.author.displayName, text: parts.join(' ') };
}

// The server nickname if the member is cached (a reply's author may not be),
// else their display name or username.
function nameIn(guild: Guild, user: User): string {
	return guild.members.cache.get(user.id)?.displayName ?? user.displayName;
}
