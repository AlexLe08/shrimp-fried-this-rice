import {
	addRecruit,
	DAY_MS,
	DEFAULT_FOLLOW_UP_DAYS,
	getOpenRecruitByName,
	getOpenRecruitCount,
	getRecruitSettings,
	MAX_OPEN_RECRUITS_PER_GUILD,
	MAX_RECRUIT_NAME_LENGTH,
	MAX_RECRUIT_NOTE_LENGTH,
} from '../storage.ts';
import { discordTime, replyEphemeral } from '../../../core/discord.ts';
import { daysOption, followUpsBlockedNotice, shownName, type RecruitSubcommand } from './helpers.ts';

export default {
	name: 'add',
	build: (subcommand) =>
		subcommand
			.setDescription('Record a trial FC member, to be followed up on later.')
			.addStringOption((option) =>
				option
					.setName('name')
					.setDescription('Their in-game name')
					.setRequired(true)
					.setMaxLength(MAX_RECRUIT_NAME_LENGTH),
			)
			.addStringOption((option) =>
				option
					.setName('note')
					.setDescription('A short note for the follow-up (e.g. who invited them)')
					.setMaxLength(MAX_RECRUIT_NOTE_LENGTH),
			)
			.addIntegerOption(daysOption('days', "Days until the follow-up (default: the server's, set by /recruit config)")),
	async execute(interaction) {
		const guildId = interaction.guildId;
		const name = interaction.options.getString('name', true).trim();
		if (!name) {
			await replyEphemeral(interaction, 'Give the trial member a name.');
			return;
		}
		if (getOpenRecruitCount(guildId) >= MAX_OPEN_RECRUITS_PER_GUILD) {
			await replyEphemeral(
				interaction,
				`This server has reached the maximum of ${MAX_OPEN_RECRUITS_PER_GUILD} open trial members. Close some with \`/recruit resolve\` first.`,
			);
			return;
		}
		if (getOpenRecruitByName(guildId, name)) {
			await replyEphemeral(
				interaction,
				`${shownName(name)} is already on the list. \`/recruit edit\` changes their entry.`,
			);
			return;
		}

		const settings = getRecruitSettings(guildId);
		const days = interaction.options.getInteger('days') ?? settings?.follow_up_days ?? DEFAULT_FOLLOW_UP_DAYS;
		const now = Date.now();
		const recruit = addRecruit({
			guildId,
			name,
			note: interaction.options.getString('note')?.trim() ?? '',
			addedBy: interaction.user.id,
			addedAt: now,
			dueAt: now + days * DAY_MS,
		});

		const where = settings ? ` in <#${settings.channel_id}>` : '';
		const blocked = followUpsBlockedNotice(settings);
		await replyEphemeral(
			interaction,
			`Added ${shownName(recruit.name)} as a trial member. I'll post a follow-up${where} ${discordTime(recruit.due_at, 'R')}, on ${discordTime(recruit.due_at, 'f')}.` +
				(blocked ? `\n\n${blocked}` : ''),
		);
	},
} satisfies RecruitSubcommand;
