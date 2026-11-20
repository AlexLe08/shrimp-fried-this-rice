import { escapeMarkdown, type Client } from 'discord.js';
import { CODE } from './reminderMessage.ts';

// The client sends a custom emoji in this form whether it was picked or typed
// (checked on the dev server: picker, `:` autocomplete and mobile alike).
const CUSTOM_EMOJI = /<a?:(\w{2,32}):(\d+)>/g;

// The warning goes into a command's reply beside other text, and Discord
// refuses a reply over 2000 characters: the reminder would be saved, but the
// admin would see an error. Server names (up to 100 characters each) make the
// length hard to bound otherwise.
const WARNING_LIMIT = 1000;
// 15 names of up to 36 characters, the sentence and an escaped server name
// keep one line under the limit, so the first line always fits.
const NAMES_PER_LINE = 15;

/**
 * A server channel a reminder is sent to. `useExternalEmojis` is null when the
 * bot's permissions there are unknown.
 */
export interface EmojiDestination {
	guildId: string;
	channelId: string;
	useExternalEmojis: boolean | null;
}

interface FromServer {
	server: string;
	names: Set<string>;
}

function addFrom(groups: Map<string, FromServer>, guild: { id: string; name: string }, name: string) {
	const group = groups.get(guild.id) ?? { server: `**${escapeMarkdown(guild.name)}**`, names: new Set<string>() };
	group.names.add(name);
	groups.set(guild.id, group);
}

function list(names: Set<string>): string {
	const all = [...names];
	const shown = all.slice(0, NAMES_PER_LINE).join(', ');
	return all.length > NAMES_PER_LINE ? `${shown} and ${all.length - NAMES_PER_LINE} more` : shown;
}

function fit(lines: string[]): string {
	let warning = '';
	for (const [i, line] of lines.entries()) {
		const next = warning ? `${warning}\n${line}` : line;
		if (warning && next.length > WARNING_LIMIT) return `${warning}\n…and ${lines.length - i} more warnings like these.`;
		warning = next;
	}
	return warning;
}

/**
 * A warning naming the custom emoji in `text` that the bot can't use where it
 * sends: Discord posts those as `:name:` text (checked on the dev server, embed
 * or not). `where` is null for a DM, which needs only that the bot be in the
 * emoji's server (checked on the dev server). The reminder is still saved: an
 * admin can fix the permission, and the text is theirs either way.
 *
 * Spoilers aren't skipped: an emoji in one renders once it's revealed (checked
 * on the dev server).
 */
export function unusableEmojiWarning(client: Client, text: string, where: EmojiDestination | null): string | null {
	const matches = [...text.replace(CODE, ' ').matchAll(CUSTOM_EMOJI)];
	if (matches.length === 0) return null;

	const unknown = new Set<string>();
	const unavailable = new Map<string, FromServer>();
	const external = new Map<string, FromServer>();
	// `client.emojis` builds a new manager from every server's emoji on each
	// read, so it's read once, and only for text with custom emoji. It leaves
	// out servers in an outage, whose emoji are then reported as unknown: a
	// rare, wrong warning, not a lost reminder.
	const cache = client.emojis.cache;

	for (const match of matches) {
		const shown = `\`:${match[1]!}:\``;
		const emoji = cache.get(match[2]!);
		if (!emoji) unknown.add(shown);
		else if (emoji.available === false) addFrom(unavailable, emoji.guild, shown);
		else if (where && emoji.guild.id !== where.guildId && where.useExternalEmojis === false) {
			addFrom(external, emoji.guild, shown);
		}
	}

	// A mention, so the admin can open the channel; a server the bot isn't in
	// has no name it can know.
	const place = where ? `<#${where.channelId}>` : 'your DMs';
	const lines: string[] = [];
	if (unknown.size > 0) {
		lines.push(
			`⚠️ These emoji are from a server I'm not in (or were deleted), so they'll show as text in ${place}: ${list(unknown)}.`,
		);
	}
	for (const { server, names } of unavailable.values()) {
		lines.push(
			`⚠️ ${server} lost the Server Boost level for these emoji, so they'll show as text in ${place}: ${list(names)}.`,
		);
	}
	for (const { server, names } of external.values()) {
		lines.push(
			`⚠️ These emoji are from another server, ${server}, and I don't have Use External Emojis in ${place}, so they'll show as text until I do: ${list(names)}.`,
		);
	}
	return lines.length > 0 ? fit(lines) : null;
}
