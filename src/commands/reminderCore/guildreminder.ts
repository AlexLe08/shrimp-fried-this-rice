import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	AutocompleteInteraction,
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
	updateGuildReminder,
	setGuildReminderEnabled,
	deleteGuildReminder,
	setGuildMasterEnabled,
	setGuildStatusMessage,
	getGuildStatusMessage,
	getGuildReminderCount,
	snoozeGuildReminder,
	unsnoozeGuildReminder,
	MAX_REMINDERS_PER_GUILD,
	MIN_INTERVAL_MINUTES,
	MAX_INTERVAL_MINUTES,
	type GuildReminder,
} from '../../storage.ts';
import {
	SNOOZE_DURATION_CHOICES,
	AFTER_SNOOZE_CHOICES,
	AFTER_SNOOZE_WAIT,
	snoozeUntil,
	isSnoozed,
	discordTime,
	describeSnooze,
} from '../../snooze.ts';
import { buildReminderStatusEmbed } from '../../reminderEmbed.ts';
import { refreshGuildStatusMessage } from '../../reminderEmbed.ts';
import type { TextChannel } from 'discord.js';

function checkChannelPermissions(
	interaction: ChatInputCommandInteraction<'cached'>,
	channel: TextChannel,
): string | null {
	// The bot's own member can be uncached right after startup. Skipping the
	// check costs only the warning; the reminder is saved either way.
	const me = interaction.guild.members.me;
	if (!me) return null;

	const perms = channel.permissionsFor(me);
	if (!perms) return null;

	const missing: string[] = [];
	if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
	if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
	// Reminders are sent as embeds.
	if (!perms.has(PermissionFlagsBits.EmbedLinks)) missing.push('Embed Links');

	if (missing.length === 0) return null;
	// Warn but still save: an admin may set the reminder up first and grant the
	// permissions after, and refusing would make them redo the whole command.
	return `⚠️ I'm missing these permissions in that channel: ${missing.join(', ')}. The reminder was saved, but it won't send until I have them.`;
}

const MESSAGE_LIMIT = 2000;

// Discord refuses a reply over 2000 characters, and 20 reminders with long
// labels (and snoozes) can pass it; the ones that don't fit are counted
// instead, and /reminder status (an embed, 4096) shows them all.
function fitList(header: string, lines: string[]): string {
	let content = header + lines.join('\n');
	for (let shown = lines.length - 1; content.length > MESSAGE_LIMIT && shown >= 0; shown--) {
		content = `${header}${lines.slice(0, shown).join('\n')}\n…and ${lines.length - shown} more; \`/reminder status\` lists them all.`;
	}
	return content;
}

// Discord shows at most 25 choices, each name at most 100 characters.
const MAX_CHOICES = 25;
const MAX_CHOICE_NAME = 100;

// Labels that start with what was typed come first, then ones that only
// contain it, so a short prefix finds its reminder at the top.
function labelChoices(
	reminders: GuildReminder[],
	typed: string,
	now: number,
	channelName: (channelId: string) => string | undefined,
): { name: string; value: string }[] {
	const query = typed.trim().toLowerCase();
	return reminders
		.filter((r) => r.reminder_label.includes(query))
		.sort(
			(a, b) =>
				Number(!a.reminder_label.startsWith(query)) - Number(!b.reminder_label.startsWith(query)) ||
				a.reminder_label.localeCompare(b.reminder_label),
		)
		.slice(0, MAX_CHOICES)
		.map((r) => {
			const parts = [r.reminder_label, `every ${r.interval_minutes}m`];
			if (!r.enabled) parts.push('disabled');
			if (isSnoozed(r.snoozed_until, now)) parts.push('💤 snoozed');
			let name = parts.join(' · ');
			// The channel goes last and alone is shortened: a channel name can be
			// 100 characters itself, and cutting there can't lose the status.
			const channel = channelName(r.channel_id);
			if (channel) name += ` · #${fitTo(channel, MAX_CHOICE_NAME - name.length - ' · #'.length)}`;
			return { name: fitTo(name, MAX_CHOICE_NAME), value: r.reminder_label };
		});
}

// Cuts whole characters, never half of a surrogate pair (an emoji in a
// channel name): a lone surrogate is invalid text, and Discord could refuse
// the whole answer. Length is in UTF-16 units, as discord.js checks it.
function fitTo(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = '';
	for (const char of text) {
		if (cut.length + char.length > max - 1) break;
		cut += char;
	}
	return `${cut}…`;
}

// Manage Server only: reminders post publicly in the server's channels.
export default {
	data: new SlashCommandBuilder()
		.setName('reminder')
		.setDescription("Manage this server's periodic reminders.")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild)
		.addSubcommand((subcommand) =>
			subcommand
				.setName('create')
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
				.addIntegerOption((option) =>
					option
						.setName('interval')
						.setDescription('How often to send this reminder, in minutes')
						.setMinValue(MIN_INTERVAL_MINUTES)
						.setMaxValue(MAX_INTERVAL_MINUTES)
						.setRequired(true),
				)
				.addStringOption((option) =>
					option.setName('message').setDescription('The reminder text to send').setMaxLength(2000).setRequired(true),
				),
		)
		.addSubcommand((subcommand) =>
			subcommand.setName('list').setDescription('List all reminders configured for this server.'),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName('toggle')
				.setDescription('Enable or disable a specific reminder.')
				.addStringOption((option) =>
					option.setName('label').setDescription("The reminder's label").setRequired(true).setAutocomplete(true),
				)
				.addBooleanOption((option) =>
					option.setName('enabled').setDescription('Whether this reminder should be active').setRequired(true),
				),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName('delete')
				.setDescription('Delete a reminder.')
				.addStringOption((option) =>
					option.setName('label').setDescription("The reminder's label").setRequired(true).setAutocomplete(true),
				),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName('master')
				.setDescription('Turn all reminders for this server on or off at once.')
				.addBooleanOption((option) =>
					option
						.setName('enabled')
						.setDescription('Whether reminders should be active for this server')
						.setRequired(true),
				),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName('edit')
				.setDescription('Edit an existing reminder.')
				.addStringOption((option) =>
					option.setName('label').setDescription("The reminder's label").setRequired(true).setAutocomplete(true),
				)
				.addChannelOption((option) =>
					option
						.setName('channel')
						.setDescription('New channel to post this reminder in')
						.addChannelTypes(ChannelType.GuildText),
				)
				.addIntegerOption((option) =>
					option
						.setName('interval')
						.setDescription('New interval in minutes')
						.setMinValue(MIN_INTERVAL_MINUTES)
						.setMaxValue(MAX_INTERVAL_MINUTES),
				)
				.addStringOption((option) => option.setName('message').setDescription('New reminder text').setMaxLength(2000)),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName('snooze')
				.setDescription('Hold a reminder back for a while; it resumes by itself when the snooze ends.')
				.addStringOption((option) =>
					option.setName('label').setDescription("The reminder's label").setRequired(true).setAutocomplete(true),
				)
				.addIntegerOption((option) =>
					option
						.setName('duration')
						.setDescription('How long to snooze it for')
						.addChoices(...SNOOZE_DURATION_CHOICES)
						.setRequired(true),
				)
				.addStringOption((option) =>
					option
						.setName('after')
						.setDescription('What happens when the snooze ends (default: send one right away if it was missed)')
						.addChoices(...AFTER_SNOOZE_CHOICES),
				),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName('unsnooze')
				.setDescription('End a snooze early.')
				.addStringOption((option) =>
					option.setName('label').setDescription("The reminder's label").setRequired(true).setAutocomplete(true),
				),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName('status')
				.setDescription("Post a live-updating embed showing this server's reminders and when they'll next fire."),
		),
	async autocomplete(interaction: AutocompleteInteraction) {
		if (!interaction.inCachedGuild()) {
			await interaction.respond([]);
			return;
		}
		const { guild } = interaction;
		await interaction.respond(
			labelChoices(
				getGuildReminders(guild.id),
				interaction.options.getFocused(),
				Date.now(),
				(channelId) => guild.channels.cache.get(channelId)?.name,
			),
		);
	},
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
			if (getGuildReminderCount(guildId) >= MAX_REMINDERS_PER_GUILD) {
				await interaction.reply({
					content: `This server has reached the maximum of ${MAX_REMINDERS_PER_GUILD} reminders. Delete one with \`/reminder delete\` before creating another.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

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

			const permissionWarning = checkChannelPermissions(interaction, channel as TextChannel);

			await interaction.reply({
				content: `Created reminder \`${label}\`: every ${interval} minutes in ${channel}.${permissionWarning ? `\n\n${permissionWarning}` : ''}`,
				flags: MessageFlags.Ephemeral,
			});
			await refreshGuildStatusMessage(interaction.client, guildId);
			return;
		}

		if (subcommand === 'edit') {
			const label = interaction.options.getString('label', true).toLowerCase();
			const channel = interaction.options.getChannel('channel');
			const interval = interaction.options.getInteger('interval');
			const message = interaction.options.getString('message');

			if (!getGuildReminderByLabel(guildId, label)) {
				await interaction.reply({
					content: `No reminder found with the label \`${label}\`.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (!channel && interval === null && message === null) {
				await interaction.reply({
					content: 'Provide at least one field to change: `channel`, `interval`, or `message`.',
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const updates: { channelId?: string; intervalMinutes?: number; message?: string } = {};
			if (channel) updates.channelId = channel.id;
			if (interval !== null) updates.intervalMinutes = interval;
			if (message !== null) updates.message = message;

			updateGuildReminder(guildId, label, updates);

			const permissionWarning = channel ? checkChannelPermissions(interaction, channel as TextChannel) : null;

			await interaction.reply({
				content: `Reminder \`${label}\` updated.${permissionWarning ? `\n\n${permissionWarning}` : ''}`,
				flags: MessageFlags.Ephemeral,
			});
			await refreshGuildStatusMessage(interaction.client, guildId);
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
			await refreshGuildStatusMessage(interaction.client, guildId);
			return;
		}

		if (subcommand === 'snooze') {
			const label = interaction.options.getString('label', true).toLowerCase();
			const duration = interaction.options.getInteger('duration', true);
			const skipMissed = interaction.options.getString('after') === AFTER_SNOOZE_WAIT;

			const reminder = getGuildReminderByLabel(guildId, label);
			if (!reminder) {
				await interaction.reply({
					content: `No reminder found with the label \`${label}\`.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const now = Date.now();
			const until = snoozeUntil(now, duration);
			snoozeGuildReminder(guildId, label, { until, skipMissed, now });

			// A snooze doesn't turn a reminder on: say so rather than let the admin
			// expect it back when the snooze ends.
			const disabledNote = reminder.enabled
				? ''
				: '\n\nIt is also disabled, so it stays off after the snooze until `/reminder toggle` turns it on.';
			await interaction.reply({
				content: `Reminder \`${label}\`: ${describeSnooze(until, skipMissed)}${disabledNote}`,
				flags: MessageFlags.Ephemeral,
			});
			await refreshGuildStatusMessage(interaction.client, guildId);
			return;
		}

		if (subcommand === 'unsnooze') {
			const label = interaction.options.getString('label', true).toLowerCase();

			const reminder = getGuildReminderByLabel(guildId, label);
			if (!reminder) {
				await interaction.reply({
					content: `No reminder found with the label \`${label}\`.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const now = Date.now();
			if (!isSnoozed(reminder.snoozed_until, now)) {
				await interaction.reply({
					content: `Reminder \`${label}\` isn't snoozed.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			unsnoozeGuildReminder(guildId, label, now);

			await interaction.reply({
				content: `Reminder \`${label}\` is no longer snoozed.`,
				flags: MessageFlags.Ephemeral,
			});
			await refreshGuildStatusMessage(interaction.client, guildId);
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
			await refreshGuildStatusMessage(interaction.client, guildId);

			return;
		}

		if (subcommand === 'master') {
			const enabled = interaction.options.getBoolean('enabled', true);
			setGuildMasterEnabled(guildId, enabled);

			await interaction.reply({
				content: `All reminders for this server are now ${enabled ? 'enabled' : 'disabled'}.`,
				flags: MessageFlags.Ephemeral,
			});
			await refreshGuildStatusMessage(interaction.client, guildId);

			return;
		}

		if (subcommand === 'list') {
			const settings = getGuildSettings(guildId);
			// No row means /reminder master was never used: on, the column's default.
			const masterEnabled = settings ? settings.master_enabled === 1 : true;

			const reminders = getGuildReminders(guildId);

			if (reminders.length === 0) {
				await interaction.reply({
					content: `**Master toggle:** ${masterEnabled ? 'enabled' : 'disabled'}\n\nThis server has no reminders configured yet. Use \`/reminder create\` to add one.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const now = Date.now();
			const lines = reminders.map((r) => {
				const snoozed = isSnoozed(r.snoozed_until, now) ? `, snoozed until ${discordTime(r.snoozed_until, 'f')}` : '';
				return `• \`${r.reminder_label}\` — every ${r.interval_minutes}m in <#${r.channel_id}> — ${r.enabled ? 'enabled' : 'disabled'}${snoozed}`;
			});

			await interaction.reply({
				content: fitList(
					`**Master toggle:** ${masterEnabled ? 'enabled' : 'disabled'}\n\n**Reminders for this server:**\n`,
					lines,
				),
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (subcommand === 'status') {
			if (!interaction.channel || !interaction.channel.isSendable()) {
				await interaction.reply({
					content: 'This command needs to be used in a text channel.',
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Deleting the old embed and posting the new one can outlast Discord's
			// 3-second window to answer an interaction, so defer first.
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });

			const existingStatus = getGuildStatusMessage(guildId);
			// One status embed per server: the previous one goes first.
			if (existingStatus) {
				try {
					// The old embed may be in another channel than this command's.
					const oldChannel = await interaction.client.channels.fetch(existingStatus.channel_id);
					if (oldChannel && oldChannel.isTextBased()) {
						const oldMessage = await oldChannel.messages.fetch(existingStatus.message_id);
						await oldMessage.delete();
					}
				} catch (error) {
					// Already deleted is fine: it's being replaced.
					console.error(`Could not delete previous status message for guild ${guildId}:`, error);
				}
			}

			const embed = buildReminderStatusEmbed(guildId, interaction.guild.name);
			const message = await interaction.channel.send({ embeds: [embed] });
			setGuildStatusMessage(guildId, message.channelId, message.id);

			// editReply, not followUp: one ephemeral message for the user, not two.
			await interaction.editReply({
				content: 'Posted! This message will keep itself updated as reminders fire.',
			});
			return;
		}
	},
};
