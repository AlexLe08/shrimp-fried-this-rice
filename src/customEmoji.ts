import type { Client } from 'discord.js';
import { HIDDEN } from './reminderMessage.ts';

// The client sends a custom emoji in this form whether it was picked or typed
// (checked on the dev server: picker, `:` autocomplete and mobile alike).
const CUSTOM_EMOJI = /<a?:(\w{2,32}):(\d+)>/g;

/**
 * Where a reminder is sent. `useExternalEmojis` is null when the bot's
 * permissions there are unknown; a DM (`where` null) needs only that the bot
 * be in the emoji's server (checked on the dev server).
 */
export interface EmojiDestination {
	guildId: string;
	useExternalEmojis: boolean | null;
}

/**
 * A warning naming the custom emoji in `text` that the bot can't use where it
 * sends: Discord posts those as `:name:` text (checked on the dev server, embed
 * or not). The reminder is still saved: an admin can fix the permission, and
 * the text is theirs either way.
 */
export function unusableEmojiWarning(client: Client, text: string, where: EmojiDestination | null): string | null {
	const unknown = new Set<string>();
	const unavailable = new Set<string>();
	const external = new Set<string>();

	for (const match of text.replace(HIDDEN, ' ').matchAll(CUSTOM_EMOJI)) {
		const shown = `\`:${match[1]!}:\``;
		const emoji = client.emojis.cache.get(match[2]!);
		if (!emoji) unknown.add(shown);
		else if (!emoji.available) unavailable.add(shown);
		else if (where && emoji.guild.id !== where.guildId && where.useExternalEmojis === false) external.add(shown);
	}

	const warnings: string[] = [];
	if (unknown.size > 0) {
		warnings.push(
			`⚠️ These emoji are from a server I'm not in (or were deleted), so they'll show as text: ${[...unknown].join(', ')}.`,
		);
	}
	if (unavailable.size > 0) {
		warnings.push(
			`⚠️ These emoji are unavailable in their server (it lost the Server Boost level for them), so they'll show as text: ${[...unavailable].join(', ')}.`,
		);
	}
	if (external.size > 0) {
		warnings.push(
			`⚠️ These emoji are from another server, and I don't have Use External Emojis in that channel, so they'll show as text until I do: ${[...external].join(', ')}.`,
		);
	}
	return warnings.length > 0 ? warnings.join('\n') : null;
}
