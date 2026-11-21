import { ChannelType } from 'discord.js';
import { updateGuildReminder } from '../storage.ts';
import { labelOption, intervalOption, messageOption, embedOption } from '../options.ts';
import { refreshGuildStatusMessage } from '../statusEmbed.ts';
import { replyEphemeral } from '../../core/discord.ts';
import {
	findReminder,
	botPermissionsIn,
	channelPermissionWarning,
	emojiWarning,
	joinWarnings,
	type ReminderSubcommand,
} from './helpers.ts';

export default {
	name: 'edit',
	build: (subcommand) =>
		subcommand
			.setDescription('Edit an existing reminder.')
			.addStringOption(labelOption)
			.addChannelOption((option) =>
				option
					.setName('channel')
					.setDescription('New channel to post this reminder in')
					.addChannelTypes(ChannelType.GuildText),
			)
			.addIntegerOption(intervalOption('New interval in minutes'))
			.addStringOption(messageOption('New reminder text'))
			.addBooleanOption(embedOption),
	async execute(interaction) {
		const channel = interaction.options.getChannel('channel', false, [ChannelType.GuildText]);
		const interval = interaction.options.getInteger('interval');
		const message = interaction.options.getString('message');
		const embed = interaction.options.getBoolean('embed');

		const reminder = await findReminder(interaction);
		if (!reminder) return;
		const label = reminder.reminder_label;

		if (!channel && interval === null && message === null && embed === null) {
			await replyEphemeral(
				interaction,
				'Provide at least one field to change: `channel`, `interval`, `message`, or `embed`.',
			);
			return;
		}

		const updates: { channelId?: string; intervalMinutes?: number; message?: string; embed?: boolean } = {};
		if (channel) updates.channelId = channel.id;
		if (interval !== null) updates.intervalMinutes = interval;
		if (message !== null) updates.message = message;
		if (embed !== null) updates.embed = embed;

		const saved = updateGuildReminder(interaction.guildId, label, updates)!;

		// A new channel, or a switch to embeds in the saved one, is worth checking.
		const checkPermissions = Boolean(channel || embed);
		// Only the text and the channel decide whether an emoji renders; an
		// interval or embed change alone would repeat the create's warning.
		const checkEmoji = Boolean(channel || message !== null);
		// Read once for both warnings: the new channel, or the saved one.
		const perms =
			checkPermissions || checkEmoji
				? botPermissionsIn(interaction, channel ?? interaction.guild.channels.cache.get(saved.channel_id))
				: null;
		const permissionWarning = checkPermissions ? channelPermissionWarning(perms, saved.embed === 1) : null;
		const emojiCheck = checkEmoji ? emojiWarning(interaction, saved.channel_id, saved.message, perms) : null;

		await replyEphemeral(interaction, `Reminder \`${label}\` updated.${joinWarnings(permissionWarning, emojiCheck)}`);
		await refreshGuildStatusMessage(interaction.client, interaction.guildId);
	},
} satisfies ReminderSubcommand;
