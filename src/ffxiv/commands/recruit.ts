import {
	SlashCommandBuilder,
	PermissionFlagsBits,
	InteractionContextType,
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
} from 'discord.js';
import { getOpenRecruits, recruitNameKey, DAY_MS, type Recruit } from '../recruit/storage.ts';
import { fitTo, replyEphemeral } from '../../core/discord.ts';
import type { RecruitSubcommand } from '../recruit/subcommands/helpers.ts';
import add from '../recruit/subcommands/add.ts';
import list from '../recruit/subcommands/list.ts';
import edit from '../recruit/subcommands/edit.ts';
import resolve from '../recruit/subcommands/resolve.ts';
import snooze from '../recruit/subcommands/snooze.ts';
import remove from '../recruit/subcommands/remove.ts';
import config from '../recruit/subcommands/config.ts';

// Discord lists subcommands in the order they're registered.
const SUBCOMMANDS: RecruitSubcommand[] = [add, list, edit, resolve, snooze, remove, config];
const BY_NAME = new Map(SUBCOMMANDS.map((subcommand) => [subcommand.name, subcommand]));

// Discord shows at most 25 choices, each name at most 100 characters.
const MAX_CHOICES = 25;
const MAX_CHOICE_NAME = 100;

// Plain text, as a choice can't show a Discord timestamp.
function dueLabel(recruit: Recruit, now: number): string {
	if (recruit.status === 'reminded') return 'followed up';
	if (recruit.due_at <= now) return 'overdue';
	const days = Math.ceil((recruit.due_at - now) / DAY_MS);
	return `due in ${days} day${days === 1 ? '' : 's'}`;
}

// Names that start with what was typed come first, then ones that only
// contain it, as /reminder's label autocomplete does.
function nameChoices(recruits: Recruit[], typed: string, now: number): { name: string; value: string }[] {
	const query = recruitNameKey(typed);
	return recruits
		.filter((r) => r.name_key.includes(query))
		.sort(
			(a, b) =>
				Number(!a.name_key.startsWith(query)) - Number(!b.name_key.startsWith(query)) ||
				a.name_key.localeCompare(b.name_key),
		)
		.slice(0, MAX_CHOICES)
		.map((r) => ({ name: fitTo(`${r.name} · ${dueLabel(r, now)}`, MAX_CHOICE_NAME), value: r.name }));
}

// Manage Server by default: notes about people are for moderators. A server
// can grant /recruit to a moderator role in Server Settings → Integrations.
const data = new SlashCommandBuilder()
	.setName('recruit')
	.setDescription('Track trial Free Company members and follow up on them.')
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
		await interaction.respond(
			nameChoices(getOpenRecruits(interaction.guildId), interaction.options.getFocused(), Date.now()),
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
