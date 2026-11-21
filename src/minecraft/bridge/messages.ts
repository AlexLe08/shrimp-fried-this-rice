import type { GatedAlert } from './alertGate.ts';
import type { AlertKind, BridgeEvent } from './classify.ts';

/** Discord's limit on a message's content. */
export const MAX_CONTENT = 2000;

export interface Message {
	content: string;
	/** The sender's name shown in Discord: the player for chat, otherwise the server. */
	username: string;
}

type NonAlert = Exclude<BridgeEvent, { type: 'alert' }>;

export function eventMessage(event: NonAlert, serverName: string): Message {
	const server = (content: string) => ({ content, username: serverName });
	switch (event.type) {
		case 'started':
			return server(`🟢 **${serverName}** is up (started in ${event.seconds} s)`);
		case 'stopping':
			return server(`🔴 **${serverName}** is stopping`);
		case 'joined':
			return server(`➕ **${escapeMarkdown(event.player)}** joined`);
		case 'left':
			return server(`➖ **${escapeMarkdown(event.player)}** left`);
		case 'chat':
			return { content: event.text, username: event.player };
	}
}

const KIND_TITLE: Record<AlertKind, string> = {
	error: 'Error',
	'bind-failed': "Can't bind to its port: the server didn't come up",
	lag: "Lagging: “Can't keep up!” repeated",
};

// Log text goes inside a code block; three backticks in a row anywhere in
// it would end the block early and let the rest render as Markdown. A
// zero-width space between every pair leaves no run of two, however long.
function defuse(text: string): string {
	return text.replace(/`(?=`)/g, '`​');
}

/**
 * A name shown as text, not formatting: vanilla names may contain `_`, so
 * `__bob__` would otherwise underline.
 */
export function escapeMarkdown(text: string): string {
	return text.replace(/[\\*_~`|>#[\]()-]/g, '\\$&');
}

export function alertMessage({ alert, repeats, capped }: GatedAlert, serverName: string): Message {
	const notes: string[] = [];
	if (repeats > 0) notes.push(`Seen ${repeats} more ${repeats === 1 ? 'time' : 'times'} since it last posted.`);
	if (capped > 0)
		notes.push(`${capped} other ${capped === 1 ? 'alert was' : 'alerts were'} held back by the per-minute cap.`);
	const head = `⚠️ **${serverName}**: ${KIND_TITLE[alert.kind]} (${alert.level})`;
	const tail = notes.length ? `\n${notes.join(' ')}` : '';
	const lines = [alert.message, ...alert.details].map(defuse);
	return { content: fitCodeBlock(head, lines, tail), username: serverName };
}

/** The gate's summaries as one message, or null when there is nothing to report. */
export function summaryMessage(
	{ repeated, capped }: { repeated: GatedAlert[]; capped: number },
	serverName: string,
): Message | null {
	const lines = repeated.map(
		({ alert, repeats }) =>
			`• ${KIND_TITLE[alert.kind]} repeated ${repeats} more ${repeats === 1 ? 'time' : 'times'}: \`${inline(alert.message)}\``,
	);
	if (capped > 0)
		lines.push(`• ${capped} more ${capped === 1 ? 'alert was' : 'alerts were'} held back by the per-minute cap`);
	if (lines.length === 0) return null;
	return {
		content: truncate(`📋 **${serverName}**: since the last alerts\n${lines.join('\n')}`),
		username: serverName,
	};
}

function inline(text: string): string {
	const flat = text.replace(/`/g, 'ˋ');
	return flat.length > 150 ? `${flat.slice(0, 149)}…` : flat;
}

/**
 * Head, the lines in a code block, then tail, within the limit: trailing lines
 * of the block go first (a stack trace's top says the most), then the first
 * line itself is shortened.
 */
function fitCodeBlock(head: string, lines: string[], tail: string): string {
	const build = (body: string) => `${head}\n\`\`\`\n${body}\n\`\`\`${tail}`;
	let kept = lines;
	let omitted = 0;
	const body = () => (omitted ? [...kept, `… ${omitted} more ${omitted === 1 ? 'line' : 'lines'}`] : kept).join('\n');
	while (kept.length > 1 && build(body()).length > MAX_CONTENT) {
		kept = kept.slice(0, -1);
		omitted++;
	}
	const full = build(body());
	if (full.length <= MAX_CONTENT) return full;
	// One line too long on its own: cut it to what's left.
	const room = MAX_CONTENT - build('').length - 1;
	const suffix = omitted ? `\n… ${omitted} more ${omitted === 1 ? 'line' : 'lines'}` : '';
	return build(`${cut(kept[0]!, room - suffix.length)}…${suffix}`);
}

/** A string within the limit, cut with an ellipsis. */
export function truncate(text: string, max = MAX_CONTENT): string {
	return text.length <= max ? text : `${cut(text, max - 1)}…`;
}

// Never leaves half of a surrogate pair (an emoji, say) at the end.
function cut(text: string, length: number): string {
	const sliced = text.slice(0, Math.max(0, length));
	const last = sliced.charCodeAt(sliced.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}
