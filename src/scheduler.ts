import { DiscordAPIError, type Client } from 'discord.js';
import {
	getDueGuildReminders,
	updateGuildReminderLastSent,
	disableGuildReminderForChannel,
	updateGuildReminderLastSentForChannel,
	getDueUserSettings,
	updateUserLastSent,
	type GuildReminder,
} from './storage.ts';
import { refreshGuildStatusMessage } from './reminderEmbed.ts';

/** How often the scheduler checks for due reminders. Should be <= the smallest allowed interval (5 min). */
const POLL_INTERVAL_MS = 60_000;

// Discord error code for a channel that no longer exists.
const UNKNOWN_CHANNEL = 10003;

// Discord answered and refused (missing access or permissions, DMs closed):
// the same send would fail again on the next poll. discord.js raises
// DiscordAPIError only for 4xx answers and queues rate limits itself; 5xx
// and timeouts arrive as other errors, after its own retries, and are
// worth trying again on the next poll.
function isRefusedByDiscord(error: unknown): error is DiscordAPIError {
	return error instanceof DiscordAPIError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

let pollIntervalID: NodeJS.Timeout | null = null;
// The check started by an earlier poll, while it runs. A poll that finds
// one still running skips it, so checks never overlap, and stopScheduler
// waits for them so shutdown doesn't close the database under a send.
let guildCheck: Promise<void> | null = null;
let userCheck: Promise<void> | null = null;
// Set by stopScheduler: a running check finishes the send it's on and
// skips the rest of its batch; they're still due after the restart.
let stopping = false;

// A check that throws (the database failing, say) is logged rather than
// left as an unhandled rejection, which would crash the process.
function runCheck(name: string, check: () => Promise<void>): Promise<void> {
	return check().catch((error: unknown) => {
		console.error(`${name} check failed:`, error);
	});
}

// Started from the ClientReady event, so the client is logged in.
export function startScheduler(client: Client<true>): void {
	stopping = false;
	pollIntervalID = setInterval(() => {
		guildCheck ??= runCheck('Guild reminder', () => checkGuildReminders(client)).finally(() => {
			guildCheck = null;
		});
		userCheck ??= runCheck('DM reminder', () => checkUserReminders(client)).finally(() => {
			userCheck = null;
		});
	}, POLL_INTERVAL_MS);

	console.log(`Scheduler started, polling every ${POLL_INTERVAL_MS / 1000}s.`);
}

/** Stops polling, then resolves once any check already running has finished. */
export async function stopScheduler(): Promise<void> {
	stopping = true;
	if (pollIntervalID) {
		clearInterval(pollIntervalID);
		pollIntervalID = null;
	}
	await Promise.all([guildCheck, userCheck]);
	console.log('Scheduler stopped.');
}

async function checkGuildReminders(client: Client<true>): Promise<void> {
	const now = Date.now();
	const dueReminders = getDueGuildReminders(now);

	// One try per reminder: a failed send must not stop the rest of the batch.
	for (const reminder of dueReminders) {
		if (stopping) break;
		try {
			// fetch, not cache.get: a quiet channel may not be cached.
			const channel = await client.channels.fetch(reminder.channel_id);

			// isSendable() checks the channel's type, not the bot's permissions.
			// A channel that is gone or can't take messages won't come back,
			// so the reminder is disabled rather than retried every poll.
			if (!channel || !channel.isSendable()) {
				await disableGuildReminder(client, reminder, `channel ${reminder.channel_id} not found or not sendable`);
				continue;
			}

			await channel.send(reminder.message);
			updateGuildReminderLastSent(reminder.id, now);
			// Shutting down: the send is recorded, and the embed's next-fire
			// time is still right after the restart. Refreshing it would only
			// spend more of the 5 seconds before index.ts forces an exit.
			if (stopping) break;
			await refreshGuildStatusMessage(client, reminder.guild_id);
		} catch (error) {
			console.error(`Failed to send guild reminder "${reminder.reminder_label}":`, error);

			if (error instanceof DiscordAPIError && error.code === UNKNOWN_CHANNEL) {
				await disableGuildReminder(client, reminder, `channel ${reminder.channel_id} was deleted`);
			} else if (isRefusedByDiscord(error)) {
				// Missing permissions can be granted later (/reminder create warns
				// but saves), so keep the reminder and try again after its interval.
				updateGuildReminderLastSentForChannel(reminder.id, reminder.channel_id, now);
			}
		}
	}
}

async function disableGuildReminder(client: Client<true>, reminder: GuildReminder, reason: string): Promise<void> {
	console.error(`Disabling reminder "${reminder.reminder_label}" (guild ${reminder.guild_id}): ${reason}.`);
	disableGuildReminderForChannel(reminder.id, reminder.channel_id);
	await refreshGuildStatusMessage(client, reminder.guild_id);
}

async function checkUserReminders(client: Client<true>): Promise<void> {
	const now = Date.now();
	const dueUsers = getDueUserSettings(now);

	for (const userSettings of dueUsers) {
		if (stopping) break;
		try {
			const user = await client.users.fetch(userSettings.user_id);
			await user.send(userSettings.message);
			updateUserLastSent(userSettings.user_id, now);
		} catch (error) {
			console.error(`Failed to send DM reminder to user ${userSettings.user_id}:`, error);

			// DMs closed, or no server shared with the bot any more: try again
			// after the user's interval instead of every poll.
			if (isRefusedByDiscord(error)) {
				updateUserLastSent(userSettings.user_id, now);
			}
		}
	}
}
