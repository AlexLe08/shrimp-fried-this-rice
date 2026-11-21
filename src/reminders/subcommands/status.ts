import { MessageFlags } from 'discord.js';
import { replaceGuildStatusMessage } from '../statusEmbed.ts';
import { replyEphemeral } from '../../core/discord.ts';
import type { ReminderSubcommand } from './helpers.ts';

export default {
	name: 'status',
	build: (subcommand) =>
		subcommand.setDescription("Post a live-updating embed showing this server's reminders and when they'll next fire."),
	async execute(interaction) {
		if (!interaction.channel || !interaction.channel.isSendable()) {
			await replyEphemeral(interaction, 'This command needs to be used in a text channel.');
			return;
		}

		// Deleting the old embed and posting the new one can outlast Discord's
		// 3-second window to answer an interaction, so defer first.
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		await replaceGuildStatusMessage(
			interaction.client,
			interaction.guildId,
			interaction.guild.name,
			interaction.channel,
		);

		// editReply, not followUp: one ephemeral message for the user, not two.
		await interaction.editReply({
			content: 'Posted! This message will keep itself updated as reminders fire.',
		});
	},
} satisfies ReminderSubcommand;
