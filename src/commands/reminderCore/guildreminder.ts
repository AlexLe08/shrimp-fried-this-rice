import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	ChannelType,
	MessageFlags,
	PermissionFlagsBits,
	InteractionContextType,
} from 'discord.js';
import {
	getGuildSettings,
	createGuildReminder,
	getGuildReminderByLabel,
	getGuildReminders,
	setGuildReminderEnabled,
	deleteGuildReminder,
	setGuildMasterEnabled,
	MIN_INTERVAL_MINUTES,
	MAX_INTERVAL_MINUTES,
} from '../../storage.ts';

// setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) ensures that only users with the "Manage Server" permission can use this command. This is important because reminders can be disruptive if misused, and we want to restrict their management to trusted users.
//.setContexts(InteractionContextType.Guild) — restricts /reminder to only be usable inside a server, never in a DM with the bot 

export default {
	data: new SlashCommandBuilder()
		.setName('reminder')
		.setDescription("Manage this server's periodic reminders.")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild)
		.addSubcommand(subcommand =>
			subcommand
				.setName('create')
				.setDescription('Create a new reminder.')
				.addStringOption(option =>
					option.setName('label')
						.setDescription('A short name for this reminder (e.g. "water")')
						.setRequired(true)
						.setMaxLength(50))
				.addChannelOption(option =>
					option.setName('channel')
						.setDescription('The channel to post this reminder in')
						.addChannelTypes(ChannelType.GuildText)
						.setRequired(true))
				.addIntegerOption(option =>
					option.setName('interval')
						.setDescription('How often to send this reminder, in minutes')
						.setMinValue(MIN_INTERVAL_MINUTES)
						.setMaxValue(MAX_INTERVAL_MINUTES)
						.setRequired(true))
				.addStringOption(option =>
					option.setName('message')
						.setDescription('The reminder text to send')
						.setMaxLength(2000)
						.setRequired(true)))
		.addSubcommand(subcommand =>
			subcommand
				.setName('list')
				.setDescription('List all reminders configured for this server.'))
		.addSubcommand(subcommand =>
			subcommand
				.setName('toggle')
				.setDescription('Enable or disable a specific reminder.')
				.addStringOption(option =>
					option.setName('label')
						.setDescription("The reminder's label")
						.setRequired(true))
				.addBooleanOption(option =>
					option.setName('enabled')
						.setDescription('Whether this reminder should be active')
						.setRequired(true)))
		.addSubcommand(subcommand =>
			subcommand
				.setName('delete')
				.setDescription('Delete a reminder.')
				.addStringOption(option =>
					option.setName('label')
						.setDescription("The reminder's label")
						.setRequired(true)))
		.addSubcommand(subcommand =>
			subcommand
				.setName('master')
				.setDescription('Turn all reminders for this server on or off at once.')
				.addBooleanOption(option =>
					option.setName('enabled')
						.setDescription('Whether reminders should be active for this server')
						.setRequired(true))),
	async execute(interaction: ChatInputCommandInteraction) {
		if (!interaction.inCachedGuild()) {
			await interaction.reply({
				content: 'This command can only be used in a server.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const subcommand = interaction.options.getSubcommand();
		const guildId = interaction.guild.id;

		if (subcommand === 'create') {
			const label = interaction.options.getString('label', true).toLowerCase();
			const channel = interaction.options.getChannel('channel', true);
			const interval = interaction.options.getInteger('interval', true);
			const message = interaction.options.getString('message', true);

			if (getGuildReminderByLabel(guildId, label)) {
				await interaction.reply({
					content: `A reminder with the label \`${label}\` already exists in this server.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			createGuildReminder({
				guildId,
				label,
				channelId: channel.id,
				intervalMinutes: interval,
				message,
			});

			await interaction.reply({
				content: `Created reminder \`${label}\`: every ${interval} minutes in ${channel}.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (subcommand === 'list') {
			const settings = getGuildSettings(guildId);
			// ternary mirrors the DEFAULT 1 behavior baked into CREATE TABLE statement; keeping the command's displayed value in sync with the database's actual default
			// getGuildSettings(guildId) returning undefined does not mean "master toggle is off" — it means "nobody has ever touched this setting, so the schema's default applies."
			const masterEnabled = settings ? settings.master_enabled === 1 : true; // defaults to on if never set

			const reminders = getGuildReminders(guildId);

			if (reminders.length === 0) {
				await interaction.reply({
					content: `**Master toggle:** ${masterEnabled ? 'enabled' : 'disabled'}\n\nThis server has no reminders configured yet. Use \`/reminder create\` to add one.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const lines = reminders.map(r =>
				`• \`${r.reminder_label}\` — every ${r.interval_minutes}m in <#${r.channel_id}> — ${r.enabled ? 'enabled' : 'disabled'}`,
			);

			await interaction.reply({
				content: `**Master toggle:** ${masterEnabled ? 'enabled' : 'disabled'}\n\n**Reminders for this server:**\n${lines.join('\n')}`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (subcommand === 'toggle') {
			const label = interaction.options.getString('label', true).toLowerCase();
			const enabled = interaction.options.getBoolean('enabled', true);

			if (!getGuildReminderByLabel(guildId, label)) {
				await interaction.reply({
					content: `No reminder found with the label \`${label}\`.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			setGuildReminderEnabled(guildId, label, enabled);

			await interaction.reply({
				content: `Reminder \`${label}\` is now ${enabled ? 'enabled' : 'disabled'}.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (subcommand === 'delete') {
			const label = interaction.options.getString('label', true).toLowerCase();

			if (!getGuildReminderByLabel(guildId, label)) {
				await interaction.reply({
					content: `No reminder found with the label \`${label}\`.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			deleteGuildReminder(guildId, label);

			await interaction.reply({
				content: `Deleted reminder \`${label}\`.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (subcommand === 'master') {
			const enabled = interaction.options.getBoolean('enabled', true);
			setGuildMasterEnabled(guildId, enabled);

			await interaction.reply({
				content: `All reminders for this server are now ${enabled ? 'enabled' : 'disabled'}.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
	},
};