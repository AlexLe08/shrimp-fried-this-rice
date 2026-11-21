import { DiscordAPIError, MessageFlags, type InteractionResponse, type RepliableInteraction } from 'discord.js';

// Discord refuses a message or reply longer than this.
export const DISCORD_MESSAGE_LIMIT = 2000;

// Code shows its text as typed, so a mention, link or emoji in it is only text.
export const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

export function replyEphemeral(interaction: RepliableInteraction, content: string): Promise<InteractionResponse> {
	return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// A Discord timestamp: shown in each reader's own time zone.
export function discordTime(ms: number, style: 'f' | 'R'): string {
	return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/**
 * As many of `lines` as fit in `limit` characters, joined by `separator`,
 * followed by `more(left out)` when some don't fit. The `more` text counts
 * towards the limit, as the limits it guards are Discord's. If not even one
 * line fits, only the `more` text is returned.
 */
export function fitLines(
	lines: string[],
	limit: number,
	{ separator = '\n', more = () => '' }: { separator?: string; more?: (leftOut: number) => string } = {},
): string {
	for (let shown = lines.length; shown > 0; shown--) {
		const leftOut = lines.length - shown;
		const content = lines.slice(0, shown).join(separator) + (leftOut > 0 ? more(leftOut) : '');
		if (content.length <= limit) return content;
	}
	return lines.length > 0 ? more(lines.length) : '';
}

// Cuts whole characters, never half of a surrogate pair (an emoji in a
// channel name): a lone surrogate is invalid text, and Discord could refuse
// the whole answer. Length is in UTF-16 units, as discord.js checks it.
export function fitTo(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = '';
	for (const char of text) {
		if (cut.length + char.length > max - 1) break;
		cut += char;
	}
	return `${cut}…`;
}

// Discord answered and refused (missing access or permissions, DMs closed):
// the same request would fail again if repeated. discord.js raises
// DiscordAPIError only for 4xx answers and queues rate limits itself; 5xx
// and timeouts arrive as other errors, after its own retries, and are
// worth trying again.
export function isRefusedByDiscord(error: unknown): error is DiscordAPIError {
	return error instanceof DiscordAPIError && error.status >= 400 && error.status < 500 && error.status !== 429;
}
