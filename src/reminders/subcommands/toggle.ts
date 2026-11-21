import { setGuildReminderEnabled } from '../storage.ts';
import { labelOption } from '../options.ts';
import { refreshGuildStatusMessage } from '../statusEmbed.ts';
import { replyEphemeral } from '../../core/discord.ts';
import { findReminder, type ReminderSubcommand } from './helpers.ts';

export default {
	name: 'toggle',
	build: (subcommand) =>
		subcommand
			.setDescription('Enable or disable a specific reminder.')
			.addStringOption(labelOption)
			.addBooleanOption((option) =>
				option.setName('enabled').setDescription('Whether this reminder should be active').setRequired(true),
			),
	async execute(interaction) {
		const enabled = interaction.options.getBoolean('enabled', true);

		const reminder = await findReminder(interaction);
		if (!reminder) return;
		const label = reminder.reminder_label;

		setGuildReminderEnabled(interaction.guildId, label, enabled);

		await replyEphemeral(interaction, `Reminder \`${label}\` is now ${enabled ? 'enabled' : 'disabled'}.`);
		await refreshGuildStatusMessage(interaction.client, interaction.guildId);
	},
} satisfies ReminderSubcommand;
