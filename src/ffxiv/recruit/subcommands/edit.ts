import {
	DAY_MS,
	getOpenRecruitByName,
	MAX_RECRUIT_NAME_LENGTH,
	MAX_RECRUIT_NOTE_LENGTH,
	updateRecruit,
} from '../storage.ts';
import { discordTime, replyEphemeral } from '../../../core/discord.ts';
import { daysOption, findRecruit, nameOption, shownName, type RecruitSubcommand } from './helpers.ts';

export default {
	name: 'edit',
	build: (subcommand) =>
		subcommand
			.setDescription("Change a trial member's note, name or follow-up date.")
			.addStringOption(nameOption)
			.addStringOption((option) =>
				option.setName('note').setDescription('A new note').setMaxLength(MAX_RECRUIT_NOTE_LENGTH),
			)
			.addStringOption((option) =>
				option.setName('new_name').setDescription('Their corrected in-game name').setMaxLength(MAX_RECRUIT_NAME_LENGTH),
			)
			.addIntegerOption(daysOption('days', 'Follow up this many days after they were added')),
	async execute(interaction) {
		const note = interaction.options.getString('note')?.trim();
		const newName = interaction.options.getString('new_name')?.trim();
		const days = interaction.options.getInteger('days');
		if (note === undefined && !newName && days === null) {
			await replyEphemeral(interaction, 'Nothing to change: give a `note`, `new_name` or `days`.');
			return;
		}

		const recruit = await findRecruit(interaction);
		if (!recruit) return;

		// Another open entry already has it. Renaming to the same name in other
		// capitals is still allowed.
		const clash = newName ? getOpenRecruitByName(interaction.guildId, newName) : undefined;
		if (newName && clash && clash.id !== recruit.id) {
			await replyEphemeral(interaction, `${shownName(newName)} is already on the list.`);
			return;
		}

		// From when they were added, as /recruit add counts it, so `days: 30`
		// means the usual follow-up whenever it's set.
		const updated = updateRecruit(recruit.id, {
			...(note === undefined ? {} : { note }),
			...(newName ? { name: newName } : {}),
			...(days === null ? {} : { dueAt: recruit.added_at + days * DAY_MS }),
		});
		if (!updated) return;

		const changes: string[] = [];
		if (newName) changes.push(`renamed from ${shownName(recruit.name)}`);
		if (note !== undefined) changes.push(note ? 'note updated' : 'note cleared');
		if (days !== null) {
			changes.push(
				updated.due_at <= Date.now()
					? 'follow-up due now'
					: `follow-up ${discordTime(updated.due_at, 'R')}, on ${discordTime(updated.due_at, 'f')}`,
			);
		}
		await replyEphemeral(interaction, `Updated ${shownName(updated.name)}: ${changes.join('; ')}.`);
	},
} satisfies RecruitSubcommand;
