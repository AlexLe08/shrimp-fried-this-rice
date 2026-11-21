import { getOpenRecruits, getRecruitSettings, type Recruit } from '../storage.ts';
import { DISCORD_MESSAGE_LIMIT, discordTime, replyEphemeral } from '../../../core/discord.ts';
import { followUpsBlockedNotice, shownName, type RecruitSubcommand } from './helpers.ts';

// Room left on each page for the header and the page line.
const PAGE_RESERVE = 600;

function entryLine(recruit: Recruit, now: number): string {
	let due: string;
	if (recruit.status === 'reminded') due = `followed up, waiting since ${discordTime(recruit.due_at, 'R')}`;
	else if (recruit.due_at <= now) due = `follow-up overdue since ${discordTime(recruit.due_at, 'R')}`;
	else due = `follow-up ${discordTime(recruit.due_at, 'R')}`;
	const line = `${shownName(recruit.name)} — ${due} · added ${discordTime(recruit.added_at, 'R')} by <@${recruit.added_by}>`;
	return recruit.note ? `${line}\n> ${recruit.note}` : line;
}

// Whole entries per page, as many as fit: a page is the same for everyone
// until the list changes, so `page: 2` needs nothing stored.
function paginate(lines: string[], limit: number): string[][] {
	const pages: string[][] = [];
	let page: string[] = [];
	let length = 0;
	for (const line of lines) {
		if (page.length > 0 && length + 1 + line.length > limit) {
			pages.push(page);
			page = [];
			length = 0;
		}
		length += (page.length > 0 ? 1 : 0) + line.length;
		page.push(line);
	}
	if (page.length > 0) pages.push(page);
	return pages;
}

export default {
	name: 'list',
	build: (subcommand) =>
		subcommand
			.setDescription('Show open trial members, the soonest follow-up first.')
			.addIntegerOption((option) =>
				option.setName('page').setDescription('Which page, for a long list').setMinValue(1),
			),
	async execute(interaction) {
		const settings = getRecruitSettings(interaction.guildId);
		const blocked = followUpsBlockedNotice(settings);
		const recruits = getOpenRecruits(interaction.guildId);
		if (recruits.length === 0) {
			await replyEphemeral(
				interaction,
				'No open trial members. `/recruit add` records one.' + (blocked ? `\n\n${blocked}` : ''),
			);
			return;
		}

		const now = Date.now();
		const pages = paginate(
			recruits.map((recruit) => entryLine(recruit, now)),
			DISCORD_MESSAGE_LIMIT - PAGE_RESERVE,
		);
		const pageNumber = Math.min(interaction.options.getInteger('page') ?? 1, pages.length);

		const parts = [`**Open trial members (${recruits.length}):**`, pages[pageNumber - 1]!.join('\n')];
		if (pages.length > 1) {
			parts.push(
				`Page ${pageNumber} of ${pages.length}` +
					(pageNumber < pages.length ? ` — \`/recruit list page:${pageNumber + 1}\` for more.` : '.'),
			);
		}
		if (blocked) parts.push(blocked);
		await replyEphemeral(interaction, parts.join('\n\n'));
	},
} satisfies RecruitSubcommand;
