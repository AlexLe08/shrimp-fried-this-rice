import { EmbedBuilder, DiscordAPIError, type Client } from 'discord.js';
import { getGuildSettings, getGuildReminders, getGuildStatusMessage, deleteGuildStatusMessage } from './storage.ts';
import { isSnoozed, discordTime } from './snooze.ts';

export function buildReminderStatusEmbed(guildId: string, guildName: string): EmbedBuilder {
	const settings = getGuildSettings(guildId);
	const masterEnabled = settings ? settings.master_enabled === 1 : true;
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
		const base = `• \`${r.reminder_label}\` — every ${r.interval_minutes}m in <#${r.channel_id}>`;

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

		const nextFireSeconds = Math.floor(nextFireMs / 1000);
		return `${base} — next <t:${nextFireSeconds}:R>`;
	});

	embed.setDescription(lines.join('\n'));
	return embed;
}

export async function refreshGuildStatusMessage(client: Client, guildId: string): Promise<void> {
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
		// Only a deleted message or channel (10008 Unknown Message, 10003 Unknown
		// Channel) clears the stored reference; anything else may be transient,
		// so it's logged and tried again on the next refresh.
		if (error instanceof DiscordAPIError && (error.code === 10008 || error.code === 10003)) {
			deleteGuildStatusMessage(guildId);
		} else {
			console.error(`Failed to refresh status message for guild ${guildId}:`, error);
		}
	}
}
