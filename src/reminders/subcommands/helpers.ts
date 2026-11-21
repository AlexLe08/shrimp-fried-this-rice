import {
	PermissionFlagsBits,
	type ChatInputCommandInteraction,
	type GuildBasedChannel,
	type PermissionsBitField,
	type SlashCommandSubcommandBuilder,
} from 'discord.js';
import { getGuildReminderByLabel, type GuildReminder } from '../storage.ts';
import { unusableEmojiWarning } from '../../core/customEmoji.ts';
import { replyEphemeral } from '../../core/discord.ts';

export type GuildCommandInteraction = ChatInputCommandInteraction<'cached'>;

// One /reminder subcommand: its definition beside its handler. `reminder.ts`
// registers them in its list's order and routes to them by name.
export interface ReminderSubcommand {
	name: string;
	build(subcommand: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder;
	execute(interaction: GuildCommandInteraction): Promise<void>;
}

// Labels are saved lowercased, so `Water` finds `water`.
export function labelOf(interaction: GuildCommandInteraction): string {
	return interaction.options.getString('label', true).toLowerCase();
}

// The reminder the `label` option names, or null once the user has been told
// there's none.
export async function findReminder(interaction: GuildCommandInteraction): Promise<GuildReminder | null> {
	const label = labelOf(interaction);
	const reminder = getGuildReminderByLabel(interaction.guildId, label);
	if (!reminder) await replyEphemeral(interaction, `No reminder found with the label \`${label}\`.`);
	return reminder ?? null;
}

// The bot's own member can be uncached right after startup. Null then means
// unknown: the warnings that need it are skipped, and the reminder is saved
// either way.
export function botPermissionsIn(
	interaction: GuildCommandInteraction,
	channel: GuildBasedChannel | undefined,
): Readonly<PermissionsBitField> | null {
	const me = interaction.guild.members.me;
	if (!me || !channel) return null;
	return channel.permissionsFor(me) ?? null;
}

export function channelPermissionWarning(perms: Readonly<PermissionsBitField> | null, embed: boolean): string | null {
	if (!perms) return null;

	const missing: string[] = [];
	if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
	if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');

	// Warn but still save: an admin may set the reminder up first and grant the
	// permissions after, and refusing would make them redo the whole command.
	const warnings: string[] = [];
	if (missing.length > 0) {
		warnings.push(
			`⚠️ I'm missing these permissions in that channel: ${missing.join(', ')}. The reminder was saved, but it won't send until I have them.`,
		);
	}
	// Without it the scheduler still sends, as plain text.
	if (embed && !perms.has(PermissionFlagsBits.EmbedLinks)) {
		warnings.push("⚠️ I can't embed links in that channel, so this reminder will be sent as plain text until I can.");
	}
	return warnings.length > 0 ? warnings.join('\n') : null;
}

// `perms` is null when the channel isn't cached; Use External Emojis is then
// unknown, and only emoji the bot can't use anywhere are flagged.
export function emojiWarning(
	interaction: GuildCommandInteraction,
	channelId: string,
	message: string,
	perms: Readonly<PermissionsBitField> | null,
): string | null {
	return unusableEmojiWarning(interaction.client, message, {
		guildId: interaction.guildId,
		channelId,
		useExternalEmojis: perms ? perms.has(PermissionFlagsBits.UseExternalEmojis) : null,
	});
}

export function joinWarnings(...warnings: (string | null)[]): string {
	const present = warnings.filter((warning) => warning !== null);
	return present.length > 0 ? `\n\n${present.join('\n')}` : '';
}
