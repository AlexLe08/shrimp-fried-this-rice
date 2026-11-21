import { EmbedBuilder, DiscordAPIError, RESTJSONErrorCodes, type MessageEditOptions } from 'discord.js';
import {
	isGuildMasterEnabled,
	getGuildReminders,
	getGuildStatusMessage,
	setGuildStatusMessage,
	deleteGuildStatusMessage,
	type GuildReminder,
} from './storage.ts';
import { isSnoozed } from './snooze.ts';
import { discordTime } from '../core/discord.ts';

// How /reminder list and the status embed both start a reminder's line.
export function reminderSummary(reminder: GuildReminder): string {
	return `• \`${reminder.reminder_label}\` — every ${reminder.interval_minutes}m in <#${reminder.channel_id}>`;
}

export function buildReminderStatusEmbed(guildId: string, guildName: string): EmbedBuilder {
	const masterEnabled = isGuildMasterEnabled(guildId);
	const reminders = getGuildReminders(guildId);

	const embed = new EmbedBuilder()
		.setTitle(`Reminders — ${guildName}`)
		.setColor(masterEnabled ? 0x57f287 : 0xed4245)
		.setFooter({ text: 'Updates automatically whenever a reminder fires' })
		.setTimestamp();

	if (reminders.length === 0) {
		embed.setDescription('No reminders configured yet. Use `/reminder create` to add one.');
		return embed;
	}

	const now = Date.now();

	const lines = reminders.map((r) => {
		const base = reminderSummary(r);

		if (!masterEnabled) {
			return `${base} — ⏸ paused (server master toggle is off)`;
		}
		if (!r.enabled) {
			return `${base} — ⏸ disabled`;
		}

		const nextFireMs = r.last_sent_at + r.interval_minutes * 60_000;

		if (isSnoozed(r.snoozed_until, now)) {
			// Sends at whichever comes later: the snooze's end or its usual time.
			return `${base} — 💤 snoozed, next ${discordTime(Math.max(r.snoozed_until, nextFireMs), 'R')}`;
		}
		if (r.last_sent_at === 0 || nextFireMs <= now) {
			return `${base} — due on next check`;
		}

		return `${base} — next ${discordTime(nextFireMs, 'R')}`;
	});

	embed.setDescription(lines.join('\n'));
	return embed;
}

// The part of the client this module uses, so tests can pass a plain fake.
// A real Client fits it, and every caller passes one, so tsc catches
// discord.js changing underneath it.
export interface StatusMessageClient {
	guilds: { fetch(id: string): Promise<{ name: string }> };
	channels: { fetch(id: string): Promise<StatusMessageChannel | null> };
}

export interface StatusMessageChannel {
	isTextBased(): this is {
		messages: {
			fetch(id: string): Promise<{ edit(options: MessageEditOptions): Promise<unknown>; delete(): Promise<unknown> }>;
		};
	};
}

export async function refreshGuildStatusMessage(client: StatusMessageClient, guildId: string): Promise<void> {
	const statusMessage = getGuildStatusMessage(guildId);
	if (!statusMessage) return;

	try {
		const guild = await client.guilds.fetch(guildId);
		const channel = await client.channels.fetch(statusMessage.channel_id);

		if (!channel || !channel.isTextBased()) return;

		const message = await channel.messages.fetch(statusMessage.message_id);
		const embed = buildReminderStatusEmbed(guildId, guild.name);
		await message.edit({ embeds: [embed] });
	} catch (error) {
		// Only a deleted message or channel clears the stored reference; anything
		// else may be transient, so it's logged and tried again on the next
		// refresh.
		if (
			error instanceof DiscordAPIError &&
			(error.code === RESTJSONErrorCodes.UnknownMessage || error.code === RESTJSONErrorCodes.UnknownChannel)
		) {
			deleteGuildStatusMessage(guildId);
		} else {
			console.error(`Failed to refresh status message for guild ${guildId}:`, error);
		}
	}
}

export interface StatusMessageTarget {
	send(options: { embeds: EmbedBuilder[] }): Promise<{ channelId: string; id: string }>;
}

// One status embed per server: posting one in `channel` deletes the previous
// one, wherever it was, and refreshes go to the new one from then on.
export async function replaceGuildStatusMessage(
	client: StatusMessageClient,
	guildId: string,
	guildName: string,
	channel: StatusMessageTarget,
): Promise<void> {
	const existing = getGuildStatusMessage(guildId);
	if (existing) {
		try {
			const oldChannel = await client.channels.fetch(existing.channel_id);
			if (oldChannel && oldChannel.isTextBased()) {
				const oldMessage = await oldChannel.messages.fetch(existing.message_id);
				await oldMessage.delete();
			}
		} catch (error) {
			// Already deleted is fine: it's being replaced.
			console.error(`Could not delete previous status message for guild ${guildId}:`, error);
		}
	}

	const message = await channel.send({ embeds: [buildReminderStatusEmbed(guildId, guildName)] });
	setGuildStatusMessage(guildId, message.channelId, message.id);
}
