import {
	Collection,
	Events,
	MessageFlags,
	type ChatInputCommandInteraction,
	type Interaction,
	type RepliableInteraction,
} from 'discord.js';
import type { Command } from '../types/command.ts';
import type { Event } from '../types/event.ts';
import { discordTime, replyEphemeral } from '../discord.ts';

const DEFAULT_COOLDOWN_SECONDS = 3;

// When the user's cooldown on `command` ends, if it hasn't yet. Otherwise this
// use starts a new one, and the result is null.
function cooldownEnd(interaction: ChatInputCommandInteraction, command: Command): number | null {
	const now = Date.now();
	const timestamps = interaction.client.cooldowns.ensure(command.data.name, () => new Collection());
	const cooldownAmount = (command.cooldown ?? DEFAULT_COOLDOWN_SECONDS) * 1_000;

	const userTimestamp = timestamps.get(interaction.user.id);
	if (userTimestamp !== undefined && now < userTimestamp + cooldownAmount) {
		return userTimestamp + cooldownAmount;
	}
	timestamps.set(interaction.user.id, now);
	setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);
	return null;
}

// The fallback reply can fail too (40060, already acknowledged, when the
// command's own reply landed right at the token's expiry). Unhandled, that
// rejection crashed the bot in production, so it is caught and logged.
async function notifyFailure(interaction: RepliableInteraction): Promise<void> {
	const errorReply = {
		content: 'There was an error while executing this command!',
		flags: MessageFlags.Ephemeral,
	} as const;
	try {
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp(errorReply);
		} else {
			await interaction.reply(errorReply);
		}
	} catch (followUpError) {
		console.error('Failed to notify the user of the earlier error:', followUpError);
	}
}

export default {
	name: Events.InteractionCreate,
	async execute(interaction: Interaction) {
		if (!interaction.isAutocomplete() && !interaction.isChatInputCommand()) return;
		const command = interaction.client.commands.get(interaction.commandName);

		if (interaction.isAutocomplete()) {
			// Ahead of the cooldown: Discord sends one of these per keystroke, and an
			// answer it never gets only leaves the list empty, so a failure is logged.
			if (!command?.autocomplete) return;
			try {
				await command.autocomplete(interaction);
			} catch (error) {
				console.error(`Autocomplete for /${interaction.commandName} failed:`, error);
			}
			return;
		}

		if (!command) {
			console.error(`No command matching ${interaction.commandName} was found.`);
			return;
		}

		const waitUntil = cooldownEnd(interaction, command);
		if (waitUntil !== null) {
			await replyEphemeral(
				interaction,
				`Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again ${discordTime(waitUntil, 'R')}.`,
			);
			return;
		}

		try {
			await command.execute(interaction);
		} catch (error) {
			console.error(error);
			await notifyFailure(interaction);
		}
	},
} satisfies Event<Events.InteractionCreate>;
