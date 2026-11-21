import { RESTJSONErrorCodes, escapeMarkdown, type MessageCreateOptions } from 'discord.js';
import { getDueRecruits, markRecruitReminded, pauseRecruitFollowUps, type DueRecruit } from './storage.ts';
import { discordTime, isRefusedByDiscord } from '../../core/discord.ts';
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

export function followUpMessage(recruit: DueRecruit): MessageCreateOptions {
	const name = escapeMarkdown(recruit.name);
	const lines = [
		`**${name}** joined as a trial member ${discordTime(recruit.added_at, 'R')} (added by <@${recruit.added_by}>).`,
	];
	if (recruit.note) lines.push(`> ${recruit.note}`);
	lines.push(
		`Are they still with us? Promote them in game, then close this with \`/recruit resolve\`, or \`/recruit snooze\` to ask again later.`,
	);
	const role = recruit.ping_role_id;
	return {
		content: (role ? `<@&${role}> ` : '') + lines.join('\n'),
		// Only the configured role is pinged: the note is free text, and the
		// moderator who added the entry is named, not pinged.
		allowedMentions: { parse: [], roles: role ? [role] : [] },
	};
}

async function postDueFollowUps(client: RecruitClient, signal: AbortSignal): Promise<void> {
	// A server paused during this batch keeps the rest of its follow-ups
	// pending, rather than failing once per entry.
	const paused = new Set<string>();

	// One try per entry: a failed post must not stop the rest of the batch.
	for (const recruit of getDueRecruits(Date.now())) {
		if (signal.aborted) break;
		if (paused.has(recruit.guild_id)) continue;
		try {
			const channel = await client.channels.fetch(recruit.channel_id);
			if (!channel || !channel.isSendable()) {
				pause(recruit, `channel ${recruit.channel_id} not found or not sendable`);
				paused.add(recruit.guild_id);
				continue;
			}
			await channel.send(followUpMessage(recruit));
			markRecruitReminded(recruit.id, recruit.due_at);
		} catch (error) {
			console.error(`Failed to post the follow-up for recruit ${recruit.id} (guild ${recruit.guild_id}):`, error);

			// A follow-up is posted once, so there's no interval to retry after.
			// A deleted channel or a refusal (missing access or permissions)
			// holds for every follow-up in that server until a moderator acts,
			// so the server's follow-ups are paused, shown in /recruit list and
			// config, and resumed by running /recruit config. Network and 5xx
			// errors are retried on the next poll.
			if (isRefusedByDiscord(error)) {
				const gone = error.code === RESTJSONErrorCodes.UnknownChannel;
				pause(recruit, gone ? `channel ${recruit.channel_id} was deleted` : `Discord refused the post (${error.code})`);
				paused.add(recruit.guild_id);
			}
		}
	}
}

function pause(recruit: DueRecruit, reason: string): void {
	console.error(`Pausing recruit follow-ups (guild ${recruit.guild_id}): ${reason}.`);
	pauseRecruitFollowUps(recruit.guild_id, recruit.channel_id);
}
