import { setGuildMasterEnabled } from '../storage.ts';
import { refreshGuildStatusMessage } from '../statusEmbed.ts';
import { replyEphemeral } from '../../core/discord.ts';
import type { ReminderSubcommand } from './helpers.ts';

export default {
	name: 'master',
	build: (subcommand) =>
		subcommand
			.setDescription('Turn all reminders for this server on or off at once.')
			.addBooleanOption((option) =>
				option
					.setName('enabled')
					.setDescription('Whether reminders should be active for this server')
					.setRequired(true),
			),
	async execute(interaction) {
		const enabled = interaction.options.getBoolean('enabled', true);
		setGuildMasterEnabled(interaction.guildId, enabled);

		await replyEphemeral(interaction, `All reminders for this server are now ${enabled ? 'enabled' : 'disabled'}.`);
		await refreshGuildStatusMessage(interaction.client, interaction.guildId);
	},
} satisfies ReminderSubcommand;
