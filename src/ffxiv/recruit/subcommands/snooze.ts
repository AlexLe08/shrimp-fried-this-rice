import { DAY_MS, updateRecruit } from '../storage.ts';
import { discordTime, replyEphemeral } from '../../../core/discord.ts';
import {
	daysOption,
	findRecruit,
	nameOption,
	shownName,
	withBlockedNotice,
	type RecruitSubcommand,
} from './helpers.ts';

export default {
	name: 'snooze',
	build: (subcommand) =>
		subcommand
			.setDescription('Ask again about a trial member later, counted from now.')
			.addStringOption(nameOption)
			.addIntegerOption(daysOption('days', 'Days from now until the next follow-up', { required: true })),
	async execute(interaction) {
		const days = interaction.options.getInteger('days', true);
		const recruit = await findRecruit(interaction);
		if (!recruit) return;

		const updated = updateRecruit(recruit.id, { dueAt: Date.now() + days * DAY_MS });
		if (!updated) return;
		await replyEphemeral(
			interaction,
			withBlockedNotice(
				interaction.guildId,
				`I'll follow up on ${shownName(updated.name)} again ${discordTime(updated.due_at, 'R')}, on ${discordTime(updated.due_at, 'f')}.`,
			),
		);
	},
} satisfies RecruitSubcommand;
