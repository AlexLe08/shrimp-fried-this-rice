import { snoozeGuildReminder } from '../storage.ts';
import {
	SNOOZE_DURATION_CHOICES,
	AFTER_SNOOZE_CHOICES,
	AFTER_SNOOZE_DESCRIPTION,
	AFTER_SNOOZE_WAIT,
	snoozeUntil,
	describeSnooze,
} from '../snooze.ts';
import { labelOption } from '../options.ts';
import { refreshGuildStatusMessage } from '../statusEmbed.ts';
import { replyEphemeral } from '../../core/discord.ts';
import { findReminder, type ReminderSubcommand } from './helpers.ts';

export default {
	name: 'snooze',
	build: (subcommand) =>
		subcommand
			.setDescription('Hold a reminder back for a while; it resumes by itself when the snooze ends.')
			.addStringOption(labelOption)
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
					.setDescription(AFTER_SNOOZE_DESCRIPTION)
					.addChoices(...AFTER_SNOOZE_CHOICES),
			),
	async execute(interaction) {
		const duration = interaction.options.getInteger('duration', true);
		const skipMissed = interaction.options.getString('after') === AFTER_SNOOZE_WAIT;

		const reminder = await findReminder(interaction);
		if (!reminder) return;
		const label = reminder.reminder_label;

		const now = Date.now();
		const until = snoozeUntil(now, duration);
		snoozeGuildReminder(interaction.guildId, label, { until, skipMissed, now });

		// A snooze doesn't turn a reminder on: say so rather than let the admin
		// expect it back when the snooze ends.
		const disabledNote = reminder.enabled
			? ''
			: '\n\nIt is also disabled, so it stays off after the snooze until `/reminder toggle` turns it on.';
		await replyEphemeral(interaction, `Reminder \`${label}\`: ${describeSnooze(until, skipMissed)}${disabledNote}`);
		await refreshGuildStatusMessage(interaction.client, interaction.guildId);
	},
} satisfies ReminderSubcommand;
