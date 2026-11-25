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
		if (relayed.take(bridge.id) > 0) continue;
		if (hub.deliver(bridge.id, chat)) recordRelayedMessage(bridge.id, message.id);
	}
}

// Webhooks are left out, the bridge's own posts of game chat among them, or
// each line would echo back into the game; so are apps and Discord's own
// messages (pins, joins, boosts, or any from its system user), and a slash
// command's reply.
function isMemberChat(message: Message): boolean {
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
function chatFor(message: Message<true>): RelayedChat | null {
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
