import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';

const REMINDER_COLOR = 0x5865f2;

// Mentions inside an embed render but don't notify, and links inside one
// get no preview, so both are repeated in the message's content. Channel
// mentions never notify and stay only in the embed.
const MENTION = /<@[!&]?\d+>|@everyone|@here/g;
// `<https://…>` is Discord's way of asking for no preview, so it's skipped.
const LINK = /(?<!<)https?:\/\/[^\s<>]+/g;
// Trailing punctuation is usually the sentence's, not the link's; this also
// drops the `)` closing a markdown link, `[text](https://…)`.
const TRAILING_PUNCTUATION = /[.,!?;:'")\]]+$/;

function pingsAndLinks(text: string): string[] {
	const found = [
		...(text.match(MENTION) ?? []),
		...(text.match(LINK) ?? []).map((link) => link.replace(TRAILING_PUNCTUATION, '')),
	];
	return [...new Set(found)];
}

/** What a reminder sends: the text in an embed, with its mentions and links above it so they still work. */
export function buildReminderMessage(title: string, text: string, intervalMinutes: number): MessageCreateOptions {
	const embed = new EmbedBuilder()
		.setTitle(title)
		.setDescription(text)
		.setColor(REMINDER_COLOR)
		.setFooter({ text: `Every ${intervalMinutes} minutes` });

	const outside = pingsAndLinks(text);
	return outside.length > 0 ? { content: outside.join(' '), embeds: [embed] } : { embeds: [embed] };
}
