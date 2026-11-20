import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';

const REMINDER_COLOR = 0x5865f2;
const MESSAGE_LIMIT = 2000;

// Code and spoilers are where an author keeps a mention from pinging or a
// link from showing, so nothing in them is repeated outside the embed.
const HIDDEN = /```[\s\S]*?```|`[^`\n]*`|\|\|[\s\S]*?\|\|/g;
// Mentions inside an embed render but don't notify, so they're repeated in
// the message's content. Not escaped ones (`\@everyone`), not `@here`
// inside an address (`bob@heretic.org`); channel mentions never notify.
const MENTION = /(?<!\\)<@[!&]?\d+>|(?<![\w\\])@(?:everyone|here)\b/g;
// Links inside an embed get no preview, so they're repeated too, except
// `<https://…>`, Discord's way of asking for none. Parentheses only when
// balanced (`wiki/Foo_(bar)`), so a markdown link's closing `)` isn't taken.
const LINK = /(?<!<)https?:\/\/(?:[^\s<>|*()]|\([^\s<>|*()]*\))+/g;
// Usually the sentence's punctuation, not the link's.
const TRAILING_PUNCTUATION = /[.,!?;:'"\]]+$/;

function outsideEmbed(text: string, mentions: boolean): string {
	const visible = text.replace(HIDDEN, ' ');
	const found = [
		...(mentions ? (visible.match(MENTION) ?? []) : []),
		...(visible.match(LINK) ?? []).map((link) => link.replace(TRAILING_PUNCTUATION, '')),
	];

	// Many short mentions joined by spaces can outgrow the text they came
	// from; content over Discord's limit would be refused on every send.
	let content = '';
	for (const item of new Set(found)) {
		const next = content ? `${content} ${item}` : item;
		if (next.length > MESSAGE_LIMIT) break;
		content = next;
	}
	return content;
}

/**
 * What a reminder sends: the text in an embed, with its mentions and links
 * above it so they still work. `mentions: false` for DMs, where they can't ping.
 */
export function buildReminderMessage(
	title: string,
	text: string,
	intervalMinutes: number,
	{ mentions = true }: { mentions?: boolean } = {},
): MessageCreateOptions {
	const embed = new EmbedBuilder()
		.setTitle(title)
		.setColor(REMINDER_COLOR)
		.setFooter({ text: `Every ${intervalMinutes} minutes` });
	// discord.js throws on an empty description, and the scheduler would
	// retry that every poll.
	if (text.trim()) embed.setDescription(text);

	const content = outsideEmbed(text, mentions);
	return content ? { content, embeds: [embed] } : { embeds: [embed] };
}
