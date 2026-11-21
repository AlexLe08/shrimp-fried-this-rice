import { resolveRecruit, type RecruitOutcome } from '../storage.ts';
import { replyEphemeral } from '../../../core/discord.ts';
import { findRecruit, nameOption, shownName, type RecruitSubcommand } from './helpers.ts';

const OUTCOMES: { name: string; value: RecruitOutcome }[] = [
	{ name: 'Promoted to full member', value: 'promoted' },
	{ name: 'Left the FC', value: 'left' },
];

export default {
	name: 'resolve',
	build: (subcommand) =>
		subcommand
			.setDescription('Close a trial member: promoted, or left.')
			.addStringOption(nameOption)
			.addStringOption((option) =>
				option
					.setName('outcome')
					.setDescription('What happened')
					.addChoices(...OUTCOMES)
					.setRequired(true),
			),
	async execute(interaction) {
		const outcome = interaction.options.getString('outcome', true) as RecruitOutcome;
		const recruit = await findRecruit(interaction);
		if (!recruit) return;

		resolveRecruit(recruit.id, outcome, interaction.user.id, Date.now());
		await replyEphemeral(
			interaction,
			`${shownName(recruit.name)} ${outcome === 'promoted' ? 'was promoted' : 'left'}; they're off the list.`,
		);
	},
} satisfies RecruitSubcommand;
