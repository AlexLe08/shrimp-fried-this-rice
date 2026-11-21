// Options /reminder's subcommands and /remindme share. Descriptions differ by
// command (a server reminder, a DM), so the caller names them; the limits are
// the same everywhere.

import type { SlashCommandBooleanOption, SlashCommandIntegerOption, SlashCommandStringOption } from 'discord.js';
import { MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES } from './storage.ts';
import { DISCORD_MESSAGE_LIMIT } from '../core/discord.ts';

export const EMBED_OPTION_DESCRIPTION =
	'Send as an embed (default: yes). Messages with links, or without Embed Links, are plain text';

// Required, and autocompleted with the server's labels (see /reminder's
// autocomplete); typing a label by hand still works.
export function labelOption(option: SlashCommandStringOption): SlashCommandStringOption {
	return option.setName('label').setDescription("The reminder's label").setRequired(true).setAutocomplete(true);
}

export function intervalOption(description: string, { required = false } = {}) {
	return (option: SlashCommandIntegerOption): SlashCommandIntegerOption =>
		option
			.setName('interval')
			.setDescription(description)
			.setMinValue(MIN_INTERVAL_MINUTES)
			.setMaxValue(MAX_INTERVAL_MINUTES)
			.setRequired(required);
}

// The text is sent as a message, so it can't be longer than one.
export function messageOption(description: string, { required = false } = {}) {
	return (option: SlashCommandStringOption): SlashCommandStringOption =>
		option.setName('message').setDescription(description).setMaxLength(DISCORD_MESSAGE_LIMIT).setRequired(required);
}

export function embedOption(option: SlashCommandBooleanOption): SlashCommandBooleanOption {
	return option.setName('embed').setDescription(EMBED_OPTION_DESCRIPTION);
}
