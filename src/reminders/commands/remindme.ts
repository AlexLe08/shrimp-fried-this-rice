import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import {
	getUserSettings,
	upsertUserSettings,
	deleteUserSettings,
	snoozeUser,
	unsnoozeUser,
	MIN_INTERVAL_MINUTES,
	MAX_INTERVAL_MINUTES,
} from '../storage.ts';
import {
	SNOOZE_DURATION_CHOICES,
	AFTER_SNOOZE_CHOICES,
	AFTER_SNOOZE_WAIT,
	snoozeUntil,
	isSnoozed,
	discordTime,
	describeSnooze,
} from '../snooze.ts';
import { EMBED_OPTION_DESCRIPTION } from '../reminderMessage.ts';
import { unusableEmojiWarning } from '../../core/customEmoji.ts';

const DEFAULT_MESSAGE = 'Time for a quick break!';
const DEFAULT_INTERVAL = 60;
// /remindme has options, not subcommands, so cancelling is a snooze choice.
const CANCEL_SNOOZE = 0;

export default {
	data: new SlashCommandBuilder()
		.setName('remindme')
		.setDescription('Configure personal DM reminders for yourself.')
		.addBooleanOption((option) => option.setName('enabled').setDescription('Whether you want to receive DM reminders'))
		.addIntegerOption((option) =>
			option
				.setName('interval')
				.setDescription('How often to DM you, in minutes')
				.setMinValue(MIN_INTERVAL_MINUTES)
				.setMaxValue(MAX_INTERVAL_MINUTES),
		)
		.addStringOption((option) =>
			option.setName('message').setDescription('The reminder text to DM you').setMaxLength(2000),
		)
		.addBooleanOption((option) => option.setName('embed').setDescription(EMBED_OPTION_DESCRIPTION))
		.addIntegerOption((option) =>
			option
				.setName('snooze')
				.setDescription('Pause your DM reminders for a while, or cancel a snooze')
				.addChoices(...SNOOZE_DURATION_CHOICES, { name: 'Cancel snooze', value: CANCEL_SNOOZE }),
		)
		.addStringOption((option) =>
			option
				.setName('after_snooze')
				.setDescription('What happens when the snooze ends (default: send one right away if it was missed)')
				.addChoices(...AFTER_SNOOZE_CHOICES),
		)
		.addBooleanOption((option) => option.setName('reset').setDescription('Delete all your personal reminder settings')),
	async execute(interaction: ChatInputCommandInteraction) {
		const resetOption = interaction.options.getBoolean('reset');
		if (resetOption) {
			deleteUserSettings(interaction.user.id);
			await interaction.reply({
				content: 'Your DM reminder settings have been deleted.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const existing = getUserSettings(interaction.user.id);

		const enabledOption = interaction.options.getBoolean('enabled');
		const intervalOption = interaction.options.getInteger('interval');
		const messageOption = interaction.options.getString('message');
		const embedOption = interaction.options.getBoolean('embed');
		const snoozeOption = interaction.options.getInteger('snooze');
		const afterSnoozeOption = interaction.options.getString('after_snooze');
		const now = Date.now();

		if (afterSnoozeOption !== null && (snoozeOption === null || snoozeOption === CANCEL_SNOOZE)) {
			await interaction.reply({
				content: '`after_snooze` only applies together with a `snooze` duration.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const changesSettings =
			enabledOption !== null || intervalOption !== null || messageOption !== null || embedOption !== null;

		if (!changesSettings && snoozeOption === null) {
			if (!existing) {
				await interaction.reply({
					content:
						"You haven't set up DM reminders yet. Provide at least one option (`enabled`, `interval`, `message`, or `embed`) to get started.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const snoozedLine = isSnoozed(existing.snoozed_until, now)
				? `\n- Snoozed until ${discordTime(existing.snoozed_until, 'f')}`
				: '';
			await interaction.reply({
				content: `Your current DM reminder settings:\n- Enabled: ${existing.dm_enabled ? 'yes' : 'no'}\n- Interval: every ${existing.interval_minutes} minutes\n- Format: ${existing.embed ? 'embed' : 'plain text'}\n- Message: ${existing.message}${snoozedLine}`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Snoozing needs a row to hold it; there's nothing to snooze before setup.
		if (!changesSettings && !existing) {
			await interaction.reply({
				content:
					"You haven't set up DM reminders yet, so there's nothing to snooze. Use `enabled`, `interval`, `message`, or `embed` to set them up first.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const replyLines: string[] = [];
		let dmEnabled = existing?.dm_enabled === 1;

		if (changesSettings) {
			// An option left out keeps its saved value, or the default for a new user.
			dmEnabled = enabledOption ?? dmEnabled;
			const intervalMinutes = intervalOption ?? existing?.interval_minutes ?? DEFAULT_INTERVAL;
			const message = messageOption ?? existing?.message ?? DEFAULT_MESSAGE;
			const embed = embedOption ?? (existing ? existing.embed === 1 : true);

			upsertUserSettings({
				userId: interaction.user.id,
				dmEnabled,
				intervalMinutes,
				message,
				embed,
			});
			replyLines.push(
				`DM reminders ${dmEnabled ? 'enabled' : 'disabled'}. Interval: every ${intervalMinutes} minutes. Format: ${embed ? 'embed' : 'plain text'}. Message: ${message}`,
			);
			const emojiWarning = messageOption !== null ? unusableEmojiWarning(interaction.client, message, null) : null;
			if (emojiWarning) replyLines.push(emojiWarning);
		}

		if (snoozeOption === CANCEL_SNOOZE) {
			if (existing && isSnoozed(existing.snoozed_until, now)) {
				unsnoozeUser(interaction.user.id, now);
				replyLines.push('Your DM reminders are no longer snoozed.');
			} else {
				replyLines.push("Your DM reminders weren't snoozed.");
			}
		} else if (snoozeOption !== null) {
			const skipMissed = afterSnoozeOption === AFTER_SNOOZE_WAIT;
			const until = snoozeUntil(now, snoozeOption);
			snoozeUser(interaction.user.id, { until, skipMissed, now });
			replyLines.push(`Your DM reminders: ${describeSnooze(until, skipMissed)}`);
			if (!dmEnabled) {
				replyLines.push('DM reminders are turned off, so none will send until you turn them on with `enabled`.');
			}
		}

		await interaction.reply({
			content: replyLines.join('\n\n'),
			flags: MessageFlags.Ephemeral,
		});
	},
};
