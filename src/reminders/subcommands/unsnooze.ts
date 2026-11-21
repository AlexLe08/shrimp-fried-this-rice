import { unsnoozeGuildReminder } from '../storage.ts';
import { isSnoozed } from '../snooze.ts';
import { labelOption } from '../options.ts';
import { refreshGuildStatusMessage } from '../statusEmbed.ts';
import { replyEphemeral } from '../../core/discord.ts';
import { findReminder, type ReminderSubcommand } from './helpers.ts';

export default {
	name: 'unsnooze',
	build: (subcommand) => subcommand.setDescription('End a snooze early.').addStringOption(labelOption),
	async execute(interaction) {
		const reminder = await findReminder(interaction);
		if (!reminder) return;
		const label = reminder.reminder_label;

		const now = Date.now();
		if (!isSnoozed(reminder.snoozed_until, now)) {
			await replyEphemeral(interaction, `Reminder \`${label}\` isn't snoozed.`);
			return;
		}

		unsnoozeGuildReminder(interaction.guildId, label, now);

		await replyEphemeral(interaction, `Reminder \`${label}\` is no longer snoozed.`);
		await refreshGuildStatusMessage(interaction.client, interaction.guildId);
	},
} satisfies ReminderSubcommand;
