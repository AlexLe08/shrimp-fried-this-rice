import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getUserSettings, upsertUserSettings, deleteUserSettings, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES } from '../../storage.ts';

const DEFAULT_MESSAGE = 'Time for a quick break!';
const DEFAULT_INTERVAL = 60;

export default {
	data: new SlashCommandBuilder()
		.setName('remindme')
		.setDescription('Configure personal DM reminders for yourself.')
		.addBooleanOption(option =>
			option.setName('enabled')
				.setDescription('Whether you want to receive DM reminders'))
		.addIntegerOption(option =>
			option.setName('interval')
				.setDescription('How often to DM you, in minutes')
				.setMinValue(MIN_INTERVAL_MINUTES)
				.setMaxValue(MAX_INTERVAL_MINUTES))
		.addStringOption(option =>
			option.setName('message')
				.setDescription('The reminder text to DM you')
				.setMaxLength(2000))
		.addBooleanOption(option =>
			option.setName('reset')
				.setDescription('Delete all your personal reminder settings')),
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

        // If the user didn't provide any options, show their current settings or a message indicating they haven't set up reminders yet.
		if (enabledOption === null && intervalOption === null && messageOption === null) {
			if (!existing) {
				await interaction.reply({
					content: "You haven't set up DM reminders yet. Provide at least one option (`enabled`, `interval`, or `message`) to get started.",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await interaction.reply({
				content: `Your current DM reminder settings:\n- Enabled: ${existing.dm_enabled ? 'yes' : 'no'}\n- Interval: every ${existing.interval_minutes} minutes\n- Message: ${existing.message}`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

        // If the user provided any options, update their settings accordingly. If an option wasn't provided, keep the existing value or use a default if no existing value is present.
        const dmEnabled = enabledOption ?? (existing?.dm_enabled === 1);
		const intervalMinutes = intervalOption ?? existing?.interval_minutes ?? DEFAULT_INTERVAL;
		const message = messageOption ?? existing?.message ?? DEFAULT_MESSAGE;

		upsertUserSettings({
			userId: interaction.user.id,
			dmEnabled,
			intervalMinutes,
			message,
		});

		await interaction.reply({
			content: `DM reminders ${dmEnabled ? 'enabled' : 'disabled'}. Interval: every ${intervalMinutes} minutes. Message: ${message}`,
			flags: MessageFlags.Ephemeral,
		});
	},
};