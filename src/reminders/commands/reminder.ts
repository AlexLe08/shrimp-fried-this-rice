import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	AutocompleteInteraction,
	PermissionFlagsBits,
	InteractionContextType,
} from 'discord.js';
import { getGuildReminders, type GuildReminder } from '../storage.ts';
import { isSnoozed } from '../snooze.ts';
import { fitTo, replyEphemeral } from '../../core/discord.ts';
import type { ReminderSubcommand } from '../subcommands/helpers.ts';
import create from '../subcommands/create.ts';
import list from '../subcommands/list.ts';
import toggle from '../subcommands/toggle.ts';
import deleteReminder from '../subcommands/delete.ts';
import master from '../subcommands/master.ts';
import edit from '../subcommands/edit.ts';
import snooze from '../subcommands/snooze.ts';
import unsnooze from '../subcommands/unsnooze.ts';
import status from '../subcommands/status.ts';

// Discord lists subcommands in the order they're registered.
const SUBCOMMANDS: ReminderSubcommand[] = [
	create,
	list,
	toggle,
	deleteReminder,
	master,
	edit,
	snooze,
	unsnooze,
	status,
];
const BY_NAME = new Map(SUBCOMMANDS.map((subcommand) => [subcommand.name, subcommand]));

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

// Manage Server only: reminders post publicly in the server's channels.
const data = new SlashCommandBuilder()
	.setName('reminder')
	.setDescription("Manage this server's periodic reminders.")
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
	.setContexts(InteractionContextType.Guild);
for (const subcommand of SUBCOMMANDS) {
	data.addSubcommand((builder) => subcommand.build(builder.setName(subcommand.name)));
}

export default {
	data,
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
			await replyEphemeral(interaction, 'This command can only be used in a server.');
			return;
		}
		await BY_NAME.get(interaction.options.getSubcommand())?.execute(interaction);
	},
};
