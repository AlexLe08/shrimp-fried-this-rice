import { ChannelType } from 'discord.js';
import {
	createGuildReminder,
	getGuildReminderByLabel,
	getGuildReminderCount,
	MAX_REMINDERS_PER_GUILD,
} from '../storage.ts';
import { intervalOption, messageOption, embedOption } from '../options.ts';
import { refreshGuildStatusMessage } from '../statusEmbed.ts';
import { replyEphemeral } from '../../core/discord.ts';
import {
	labelOf,
	botPermissionsIn,
	channelPermissionWarning,
	emojiWarning,
	joinWarnings,
	type ReminderSubcommand,
} from './helpers.ts';

export default {
	name: 'create',
	build: (subcommand) =>
		subcommand
			.setDescription('Create a new reminder.')
			.addStringOption((option) =>
				option
					.setName('label')
					.setDescription('A short name for this reminder (e.g. "water")')
					.setRequired(true)
					.setMaxLength(50),
			)
			.addChannelOption((option) =>
				option
					.setName('channel')
					.setDescription('The channel to post this reminder in')
					.addChannelTypes(ChannelType.GuildText)
					.setRequired(true),
			)
			.addIntegerOption(intervalOption('How often to send this reminder, in minutes', { required: true }))
			.addStringOption(messageOption('The reminder text to send', { required: true }))
			.addBooleanOption(embedOption),
	async execute(interaction) {
		const guildId = interaction.guildId;
		const label = labelOf(interaction);
		if (getGuildReminderCount(guildId) >= MAX_REMINDERS_PER_GUILD) {
			await replyEphemeral(
				interaction,
				`This server has reached the maximum of ${MAX_REMINDERS_PER_GUILD} reminders. Delete one with \`/reminder delete\` before creating another.`,
			);
			return;
		}

		const channel = interaction.options.getChannel('channel', true, [ChannelType.GuildText]);
		const interval = interaction.options.getInteger('interval', true);
		const message = interaction.options.getString('message', true);
		const embed = interaction.options.getBoolean('embed') ?? true;

		if (getGuildReminderByLabel(guildId, label)) {
			await replyEphemeral(interaction, `A reminder with the label \`${label}\` already exists in this server.`);
			return;
		}

		createGuildReminder({
			guildId,
			label,
			channelId: channel.id,
			intervalMinutes: interval,
			message,
			embed,
		});

		const perms = botPermissionsIn(interaction, channel);
		const warnings = joinWarnings(
			channelPermissionWarning(perms, embed),
			emojiWarning(interaction, channel.id, message, perms),
		);

		await replyEphemeral(
			interaction,
			`Created reminder \`${label}\`: every ${interval} minutes in ${channel}, as ${embed ? 'an embed' : 'plain text'}.${warnings}`,
		);
		await refreshGuildStatusMessage(interaction.client, guildId);
	},
} satisfies ReminderSubcommand;
