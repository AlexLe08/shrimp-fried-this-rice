import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';

const REMINDER_COLOR = 0x5865f2;
const MESSAGE_LIMIT = 2000;

// Code and spoilers are where an author keeps a mention from pinging or a
// link from showing, so they don't count for either.
const HIDDEN = /```[\s\S]*?```|`[^`\n]*`|\|\|[\s\S]*?\|\|/g;
// Mentions inside an embed render but don't notify (checked on the dev
// server: Discord lists no mentions for them), so they're repeated in the
// message's content. Not escaped ones (`\@everyone`), not `@here` inside an
// address (`bob@heretic.org`); channel mentions never notify.
const MENTION = /(?<!\\)<@[!&]?\d+>|(?<![\w\\])@(?:everyone|here)\b/g;
// `<https://…>` is Discord's way of asking for no preview.
const LINK = /(?<!<)https?:\/\/\S/;

function mentionsOutsideEmbed(visible: string): string {
	// Many short mentions joined by spaces can outgrow the text they came
	// from; content over Discord's limit would be refused on every send.
	let content = '';
	for (const mention of new Set(visible.match(MENTION) ?? [])) {
		const next = content ? `${content} ${mention}` : mention;
		if (next.length > MESSAGE_LIMIT) break;
		content = next;
	}
	return content;
}

/**
 * What a reminder sends: the text in an embed, with its mentions above it so
 * they still ping. `mentions: false` for DMs, where they can't.
 */
export function buildReminderMessage(
	title: string,
	text: string,
	intervalMinutes: number,
	{ mentions = true }: { mentions?: boolean } = {},
): MessageCreateOptions {
	const visible = text.replace(HIDDEN, ' ');

	// Discord doesn't preview links in a bot message that has its own embed
	// (checked on the dev server: the same YouTube link previewed as plain
	// text and never above an embed), so a reminder with a GIF or video
	// link is sent as plain text, as before embeds, to keep its preview.
	if (LINK.test(visible)) return { content: text };

	const embed = new EmbedBuilder()
		.setTitle(title)
		.setColor(REMINDER_COLOR)
		.setFooter({ text: `Every ${intervalMinutes} minutes` });
	// discord.js throws on an empty description, and the scheduler would
	// retry that every poll.
	if (text.trim()) embed.setDescription(text);

	const content = mentions ? mentionsOutsideEmbed(visible) : '';
	return content ? { content, embeds: [embed] } : { embeds: [embed] };
}
