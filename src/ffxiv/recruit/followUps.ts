import { RESTJSONErrorCodes, escapeMarkdown, type MessageCreateOptions } from 'discord.js';
import { getDueRecruits, markRecruitReminded, pauseRecruitFollowUps, type DueRecruit } from './storage.ts';
import { DISCORD_MESSAGE_LIMIT, discordTime, isRefusedByDiscord } from '../../core/discord.ts';
import type { ScheduledCheck } from '../../core/scheduler.ts';

// The part of the client the check uses, so tests can pass a plain fake
// (as SchedulerClient is for the reminder checks).
export interface RecruitClient {
	channels: { fetch(id: string): Promise<RecruitChannel | null> };
}

interface Sendable {
	send(options: MessageCreateOptions): Promise<unknown>;
}

interface RecruitChannel {
	isSendable(): this is Sendable;
}

/** The follow-up check for startScheduler: posts each recruit once their follow-up is due. */
export function recruitFollowUpCheck(client: RecruitClient): ScheduledCheck {
	return { name: 'Recruit follow-up', run: (signal) => postDueFollowUps(client, signal) };
}

// A note as one quoted line: a line break (possible from some clients)
// would end the quote and leave the rest looking like the bot's own text.
export function quotedNote(note: string): string {
	return `> ${note.replace(/\s*\n\s*/g, ' ')}`;
}

function entry(recruit: DueRecruit): string {
	const line = `**${escapeMarkdown(recruit.name)}** joined as a trial member ${discordTime(recruit.added_at, 'R')} (added by <@${recruit.added_by}>).`;
	return recruit.note ? `${line}\n${quotedNote(recruit.note)}` : line;
}

const CLOSING =
	'Are they still with us? Promote them in game, then close each with `/recruit resolve`, or `/recruit snooze` to ask again later.';
const MORE = (left: number) => `…and ${left} more in the next post.`;
// Room for MORE with any count up to the open-entry cap.
const MORE_RESERVE = MORE(1000).length + 1;

/**
 * One post for a server's due follow-ups, and which of them it holds: as
 * many as fit in one message, in order. The rest stay due for the next poll.
 */
export function followUpMessage(recruits: DueRecruit[]): { message: MessageCreateOptions; posted: DueRecruit[] } {
	const role = recruits[0]?.ping_role_id ?? null;
	const ping = role ? `<@&${role}> ` : '';
	const room = DISCORD_MESSAGE_LIMIT - ping.length - CLOSING.length - 1 - MORE_RESERVE;

	const blocks: string[] = [];
	let length = 0;
	for (const recruit of recruits) {
		const block = entry(recruit);
		const added = (blocks.length > 0 ? 1 : 0) + block.length;
		if (blocks.length > 0 && length + added > room) break;
		blocks.push(block);
		length += added;
	}
	const posted = recruits.slice(0, blocks.length);
	const left = recruits.length - posted.length;

	const lines = [...blocks, CLOSING];
	if (left > 0) lines.push(MORE(left));
	return {
		message: {
			content: ping + lines.join('\n'),
			// Only the configured role is pinged: the note is free text, and the
			// moderator who added the entry is named, not pinged.
			allowedMentions: { parse: [], roles: role ? [role] : [] },
		},
		posted,
	};
}

// Due entries by server, in due order within each.
function byGuild(recruits: DueRecruit[]): DueRecruit[][] {
	const groups = new Map<string, DueRecruit[]>();
	for (const recruit of recruits) {
		const group = groups.get(recruit.guild_id);
		if (group) group.push(recruit);
		else groups.set(recruit.guild_id, [recruit]);
	}
	return [...groups.values()];
}

// One post per server per poll, pinging once: a backlog (entries that came
// due while follow-ups were paused or not yet set up, up to the 100-entry
// cap) would otherwise ping the role once per entry.
async function postDueFollowUps(client: RecruitClient, signal: AbortSignal): Promise<void> {
	// One try per server: a failed post must not stop the other servers'.
	for (const due of byGuild(getDueRecruits(Date.now()))) {
		if (signal.aborted) break;
		const first = due[0]!;
		try {
			const channel = await client.channels.fetch(first.channel_id);
			if (!channel || !channel.isSendable()) {
				pause(first, `channel ${first.channel_id} not found or not sendable`);
				continue;
			}
			const { message, posted } = followUpMessage(due);
			await channel.send(message);
			for (const recruit of posted) markRecruitReminded(recruit.id, recruit.due_at);
		} catch (error) {
			console.error(`Failed to post recruit follow-ups (guild ${first.guild_id}):`, error);

			// A follow-up is posted once, so there's no interval to retry after.
			// A deleted channel or a refusal (missing access or permissions)
			// holds for every follow-up in that server until a moderator acts,
			// so the server's follow-ups are paused, shown in /recruit list and
			// config, and resumed by running /recruit config. Network and 5xx
			// errors are retried on the next poll.
			if (isRefusedByDiscord(error)) {
				const gone = error.code === RESTJSONErrorCodes.UnknownChannel;
				pause(first, gone ? `channel ${first.channel_id} was deleted` : `Discord refused the post (${error.code})`);
			}
		}
	}
}

function pause(recruit: DueRecruit, reason: string): void {
	console.error(`Pausing recruit follow-ups (guild ${recruit.guild_id}): ${reason}.`);
	pauseRecruitFollowUps(recruit.guild_id, recruit.channel_id);
}
