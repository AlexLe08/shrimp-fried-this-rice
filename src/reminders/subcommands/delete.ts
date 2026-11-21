import { deleteGuildReminder } from '../storage.ts';
import { labelOption } from '../options.ts';
import { refreshGuildStatusMessage } from '../statusEmbed.ts';
import { replyEphemeral } from '../../core/discord.ts';
import { findReminder, type ReminderSubcommand } from './helpers.ts';

export default {
	name: 'delete',
	build: (subcommand) => subcommand.setDescription('Delete a reminder.').addStringOption(labelOption),
	async execute(interaction) {
		const reminder = await findReminder(interaction);
		if (!reminder) return;
		const label = reminder.reminder_label;

		deleteGuildReminder(interaction.guildId, label);

		await replyEphemeral(interaction, `Deleted reminder \`${label}\`.`);
		await refreshGuildStatusMessage(interaction.client, interaction.guildId);
	},
} satisfies ReminderSubcommand;
