import type { Client } from 'discord.js';
import {
	getDueGuildReminders,
	updateGuildReminderLastSent,
	getDueUserSettings,
	updateUserLastSent,
} from './storage.ts';

/** How often the scheduler checks for due reminders. Should be <= the smallest allowed interval (5 min). */
const POLL_INTERVAL_MS = 60_000; // check every 1 minute

// Scheduler will only ever be started when bot is logged in; we can assume client is fully connected with no null checks.
export function startScheduler(client: Client<true>): void {
    // setInterval can't be async, so we wrap the async function in a void call to avoid unhandled promise rejections
	setInterval(() => {
		void checkGuildReminders(client);
		void checkUserReminders(client);
	}, POLL_INTERVAL_MS);

	console.log(`Scheduler started, polling every ${POLL_INTERVAL_MS / 1000}s.`);
}

async function checkGuildReminders(client: Client<true>): Promise<void> {
	const now = Date.now();
	const dueReminders = getDueGuildReminders(now);

    // if reminder #1 fails (bad channel ID, missing permissions, etc.), reminders #2 and #3 in the same batch should still go out.
    // Wrapping the whole function in one try/catch would mean a single bad reminder silently kills every other reminder due in that same poll cycle.
	for (const reminder of dueReminders) {
		try {
            // fetch() will reach out to discord's API if channel isn't already cached; .cache.get() will only check the cache and return undefined if not found. fetch() is more reliable for reminders that may have been set in a channel that isn't frequently used, so it may not be cached.
			const channel = await client.channels.fetch(reminder.channel_id);

            // isSendable() is a more precise check than isTextBased(); excludes voice channels, categories, and other non-text channels that would pass isTextBased(). It also checks for permissions to send messages in the channel.
			if (!channel || !channel.isSendable()) {
				console.error(
					`Reminder "${reminder.reminder_label}" (guild ${reminder.guild_id}): channel ${reminder.channel_id} not found or not sendable.`,
				);
				continue;
			}

			await channel.send(reminder.message);
			updateGuildReminderLastSent(reminder.id, now);
		} catch (error) {
			console.error(`Failed to send guild reminder "${reminder.reminder_label}":`, error);
		}
	}
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
		}
	}
}