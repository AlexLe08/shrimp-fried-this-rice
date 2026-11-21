import { deleteRecruit } from '../storage.ts';
import { replyEphemeral } from '../../../core/discord.ts';
import { findRecruit, nameOption, shownName, type RecruitSubcommand } from './helpers.ts';

export default {
	name: 'remove',
	build: (subcommand) =>
		subcommand
			.setDescription('Delete a trial member added by mistake (use resolve for one who was promoted or left).')
			.addStringOption(nameOption),
	async execute(interaction) {
		const recruit = await findRecruit(interaction);
		if (!recruit) return;

		deleteRecruit(recruit.id);
		await replyEphemeral(interaction, `Removed ${shownName(recruit.name)}.`);
	},
} satisfies RecruitSubcommand;
