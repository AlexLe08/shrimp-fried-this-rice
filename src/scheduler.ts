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
import { refreshGuildStatusMessage } from './reminderEmbed.ts'

/** How often the scheduler checks for due reminders. Should be <= the smallest allowed interval (5 min). */
const POLL_INTERVAL_MS = 60_000; // check every 1 minute

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
let isCheckingGuildReminders = false;
let isCheckingUserReminders = false;
// Scheduler will only ever be started when bot is logged in; we can assume client is fully connected with no null checks.
export function startScheduler(client: Client<true>): void {
	pollIntervalID = setInterval(() => {
		// If a previous check is still running, skip this interval.
		// This prevents overlapping checks if one takes longer than the poll interval.
		if (!isCheckingGuildReminders) {
			isCheckingGuildReminders = true;
			checkGuildReminders(client).finally(() => {
				isCheckingGuildReminders = false;
			})
		}

		if (!isCheckingUserReminders) {
			isCheckingUserReminders = true;
			checkUserReminders(client).finally(() => {
				isCheckingUserReminders = false;
			})
		}
	}, POLL_INTERVAL_MS);

	console.log(`Scheduler started, polling every ${POLL_INTERVAL_MS / 1000}s.`);
}

export function stopScheduler(): void {
	if (pollIntervalID) {
		clearInterval(pollIntervalID);
		pollIntervalID = null;
		console.log('Scheduler stopped.');
	}
}

async function checkGuildReminders(client: Client<true>): Promise<void> {
	const now = Date.now();
	const dueReminders = getDueGuildReminders(now);

    // if reminder #1 fails (bad channel ID, missing permissions, etc.), reminders #2 and #3 in the same batch should still go out.
    // Wrapping the whole function in one try/catch would mean a single bad reminder silently kills every other reminder due in that same poll cycle.
	for (const reminder of dueReminders) {
		try {
            // fetch() will reach out to discord's API if channel isn't already cached; 
            // .cache.get() will only check the cache and return undefined if not found. 
            // fetch() is more reliable for reminders that may have been set in a channel that isn't frequently used, so it may not be cached.
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