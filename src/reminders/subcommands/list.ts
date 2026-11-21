import { isGuildMasterEnabled, getGuildReminders } from '../storage.ts';
import { isSnoozed } from '../snooze.ts';
import { reminderSummary } from '../statusEmbed.ts';
import { DISCORD_MESSAGE_LIMIT, discordTime, fitLines, replyEphemeral } from '../../core/discord.ts';
import type { ReminderSubcommand } from './helpers.ts';

// Discord refuses a reply over 2000 characters, and 20 reminders with long
// labels (and snoozes) can pass it; the ones that don't fit are counted
// instead, and /reminder status (an embed, 4096) shows them all.
function fitList(header: string, lines: string[]): string {
	return (
		header +
		fitLines(lines, DISCORD_MESSAGE_LIMIT - header.length, {
			more: (leftOut) => `\n…and ${leftOut} more; \`/reminder status\` lists them all.`,
		})
	);
}

export default {
	name: 'list',
	build: (subcommand) => subcommand.setDescription('List all reminders configured for this server.'),
	async execute(interaction) {
		const masterLine = `**Master toggle:** ${isGuildMasterEnabled(interaction.guildId) ? 'enabled' : 'disabled'}`;
		const reminders = getGuildReminders(interaction.guildId);

		if (reminders.length === 0) {
			await replyEphemeral(
				interaction,
				`${masterLine}\n\nThis server has no reminders configured yet. Use \`/reminder create\` to add one.`,
			);
			return;
		}

		const now = Date.now();
		const lines = reminders.map((r) => {
			const snoozed = isSnoozed(r.snoozed_until, now) ? `, snoozed until ${discordTime(r.snoozed_until, 'f')}` : '';
			const plain = r.embed ? '' : ', plain text';
			return `${reminderSummary(r)} — ${r.enabled ? 'enabled' : 'disabled'}${plain}${snoozed}`;
		});

		await replyEphemeral(interaction, fitList(`${masterLine}\n\n**Reminders for this server:**\n`, lines));
	},
} satisfies ReminderSubcommand;
