import {
	DiscordAPIError,
	PermissionFlagsBits,
	RESTJSONErrorCodes,
	type MessageCreateOptions,
	type PermissionResolvable,
	type UserResolvable,
} from 'discord.js';
import {
	getDueGuildReminders,
	updateGuildReminderLastSent,
	disableGuildReminderForChannel,
	updateGuildReminderLastSentForChannel,
	getDueUserSettings,
	updateUserLastSent,
	type GuildReminder,
} from './storage.ts';
import { refreshGuildStatusMessage, type StatusMessageChannel, type StatusMessageClient } from './statusEmbed.ts';
import { reminderContent } from './reminderMessage.ts';
import { isRefusedByDiscord } from '../core/discord.ts';
import type { ScheduledCheck } from '../core/scheduler.ts';

// The part of the client the reminder checks use, so tests can pass a plain
// fake (see StatusMessageClient).
export interface SchedulerClient extends StatusMessageClient {
	user: UserResolvable;
	channels: { fetch(id: string): Promise<SchedulerChannel | null> };
	users: { fetch(id: string): Promise<Sendable> };
}

interface Sendable {
	send(content: string | MessageCreateOptions): Promise<unknown>;
}

// Only guild channels have permissionsFor; a DM channel doesn't.
interface SchedulerChannel extends StatusMessageChannel {
	isSendable(): this is Sendable;
	permissionsFor?(user: UserResolvable): { has(permission: PermissionResolvable): boolean } | null;
}

/** The reminder checks for startScheduler: server reminders and DM reminders. */
export function dueReminderChecks(client: SchedulerClient): ScheduledCheck[] {
	return [
		{ name: 'Guild reminder', run: (signal) => checkGuildReminders(client, signal) },
		{ name: 'DM reminder', run: (signal) => checkUserReminders(client, signal) },
	];
}

async function checkGuildReminders(client: SchedulerClient, signal: AbortSignal): Promise<void> {
	const now = Date.now();
	const dueReminders = getDueGuildReminders(now);

	// One try per reminder: a failed send must not stop the rest of the batch.
	for (const reminder of dueReminders) {
		if (signal.aborted) break;
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

			// Discord refuses a bot's embed where it lacks Embed Links (50013,
			// seen on the dev server), and a refused send is only retried an
			// interval later, so the reminder would never arrive. A reminder
			// saved before the warning, or an override added since, gets the
			// plain text that worked before embeds.
			const canEmbed =
				!('permissionsFor' in channel) ||
				channel.permissionsFor(client.user)?.has(PermissionFlagsBits.EmbedLinks) !== false;
			await channel.send(
				reminderContent(reminder.reminder_label, reminder.message, reminder.interval_minutes, {
					embed: canEmbed && reminder.embed === 1,
				}),
			);
			updateGuildReminderLastSent(reminder.id, now);
			// Shutting down: the send is recorded, and the embed's next-fire
			// time is still right after the restart. Refreshing it would only
			// spend more of the 5 seconds before index.ts forces an exit.
			if (signal.aborted) break;
			await refreshGuildStatusMessage(client, reminder.guild_id);
		} catch (error) {
			console.error(`Failed to send guild reminder "${reminder.reminder_label}":`, error);

			if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) {
				await disableGuildReminder(client, reminder, `channel ${reminder.channel_id} was deleted`);
			} else if (isRefusedByDiscord(error)) {
				// Missing permissions can be granted later (/reminder create warns
				// but saves), so keep the reminder and try again after its interval.
				updateGuildReminderLastSentForChannel(reminder.id, reminder.channel_id, now);
			}
		}
	}
}

async function disableGuildReminder(client: SchedulerClient, reminder: GuildReminder, reason: string): Promise<void> {
	console.error(`Disabling reminder "${reminder.reminder_label}" (guild ${reminder.guild_id}): ${reason}.`);
	disableGuildReminderForChannel(reminder.id, reminder.channel_id);
	await refreshGuildStatusMessage(client, reminder.guild_id);
}

async function checkUserReminders(client: SchedulerClient, signal: AbortSignal): Promise<void> {
	const now = Date.now();
	const dueUsers = getDueUserSettings(now);

	for (const userSettings of dueUsers) {
		if (signal.aborted) break;
		try {
			const user = await client.users.fetch(userSettings.user_id);
			await user.send(
				reminderContent('Reminder', userSettings.message, userSettings.interval_minutes, {
					embed: userSettings.embed === 1,
					mentions: false,
				}),
			);
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
