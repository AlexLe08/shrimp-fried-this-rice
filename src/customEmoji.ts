import type { Client } from 'discord.js';
import { CODE } from './reminderMessage.ts';

// The client sends a custom emoji in this form whether it was picked or typed
// (checked on the dev server: picker, `:` autocomplete and mobile alike).
const CUSTOM_EMOJI = /<a?:(\w{2,32}):(\d+)>/g;

/**
 * A server channel a reminder is sent to. `useExternalEmojis` is null when the
 * bot's permissions there are unknown.
 */
export interface EmojiDestination {
	guildId: string;
	useExternalEmojis: boolean | null;
}

/**
 * A warning naming the custom emoji in `text` that the bot can't use where it
 * sends: Discord posts those as `:name:` text (checked on the dev server, embed
 * or not). `where` is null for a DM, which needs only that the bot be in the
 * emoji's server (checked on the dev server). The reminder is still saved: an
 * admin can fix the permission, and the text is theirs either way.
 *
 * Spoilers aren't skipped: an emoji in one still renders once it's revealed.
 */
export function unusableEmojiWarning(client: Client, text: string, where: EmojiDestination | null): string | null {
	const matches = [...text.replace(CODE, ' ').matchAll(CUSTOM_EMOJI)];
	if (matches.length === 0) return null;

	const unknown = new Set<string>();
	const unavailable = new Set<string>();
	const external = new Set<string>();
	// `client.emojis` builds a new manager from every server's emoji on each
	// read, so it's read once, and only for text with custom emoji. It leaves
	// out servers in an outage, whose emoji are then reported as unknown: a
	// rare, wrong warning, not a lost reminder.
	const cache = client.emojis.cache;

	for (const match of matches) {
		const shown = `\`:${match[1]!}:\``;
		const emoji = cache.get(match[2]!);
		if (!emoji) unknown.add(shown);
		else if (emoji.available === false) unavailable.add(shown);
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
