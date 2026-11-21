import {
	escapeMarkdown,
	type ChatInputCommandInteraction,
	type SlashCommandIntegerOption,
	type SlashCommandStringOption,
	type SlashCommandSubcommandBuilder,
} from 'discord.js';
import {
	getOpenRecruitByName,
	getRecruitSettings,
	MAX_FOLLOW_UP_DAYS,
	MAX_RECRUIT_NAME_LENGTH,
	MIN_FOLLOW_UP_DAYS,
	type Recruit,
	type RecruitSettings,
} from '../storage.ts';
import { replyEphemeral } from '../../../core/discord.ts';

export type GuildCommandInteraction = ChatInputCommandInteraction<'cached'>;

// One /recruit subcommand: its definition beside its handler. `recruit.ts`
// registers them in its list's order and routes to them by name.
export interface RecruitSubcommand {
	name: string;
	build(subcommand: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder;
	execute(interaction: GuildCommandInteraction): Promise<void>;
}

// Autocompleted with the server's open entries (see /recruit's
// autocomplete); typing a name by hand still works.
export function nameOption(option: SlashCommandStringOption): SlashCommandStringOption {
	return option
		.setName('name')
		.setDescription("The trial member's in-game name")
		.setRequired(true)
		.setMaxLength(MAX_RECRUIT_NAME_LENGTH)
		.setAutocomplete(true);
}

export function daysOption(name: string, description: string, { required = false } = {}) {
	return (option: SlashCommandIntegerOption): SlashCommandIntegerOption =>
		option
			.setName(name)
			.setDescription(description)
			.setMinValue(MIN_FOLLOW_UP_DAYS)
			.setMaxValue(MAX_FOLLOW_UP_DAYS)
			.setRequired(required);
}

// In-game names are shown as typed, but a `_` or `*` in one isn't markdown.
export function shownName(name: string): string {
	return `**${escapeMarkdown(name)}**`;
}

// The open entry the `name` option names, or null once the user has been
// told there's none.
export async function findRecruit(interaction: GuildCommandInteraction): Promise<Recruit | null> {
	const name = interaction.options.getString('name', true);
	const recruit = getOpenRecruitByName(interaction.guildId, name);
	if (!recruit) {
		await replyEphemeral(
			interaction,
			`No open trial member named ${shownName(name.trim())}. \`/recruit list\` shows who's open.`,
		);
	}
	return recruit ?? null;
}

/**
 * Why follow-ups won't be posted in this server, if they won't: no settings
 * yet, or paused after a failed post (src/ffxiv/recruit/followUps.ts).
 */
export function followUpsBlockedNotice(settings: RecruitSettings | undefined): string | null {
	if (!settings) {
		return "⚠️ Follow-ups aren't posted until a channel is set with `/recruit config channel:`.";
	}
	if (!settings.enabled) {
		return `⚠️ Follow-ups are paused: I couldn't post in <#${settings.channel_id}>. Give me View Channel and Send Messages there, or pick another channel, then run \`/recruit config channel:\` to resume.`;
	}
	return null;
}

// A reply about when a follow-up comes, with why it won't, if it won't.
export function withBlockedNotice(guildId: string, reply: string): string {
	const blocked = followUpsBlockedNotice(getRecruitSettings(guildId));
	return blocked ? `${reply}\n\n${blocked}` : reply;
}
