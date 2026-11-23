import { Client, Events } from 'discord.js';
import type { Event } from '../types/event.ts';
import { startScheduler } from '../scheduler.ts';
import { dueReminderChecks } from '../../reminders/dueReminders.ts';
import { recruitFollowUpCheck } from '../../ffxiv/recruit/followUps.ts';
import { backupDirectory, db } from '../database.ts';
import { dailyBackupCheck } from '../backup.ts';

export default {
	name: Events.ClientReady,
	once: true,
	execute(client: Client<true>) {
		// The deploy job waits for this exact line to confirm the bot logged in.
		console.log(`Ready! Logged in as ${client.user.tag}`);
		const backups = backupDirectory();
		startScheduler([
			...dueReminderChecks(client),
			recruitFollowUpCheck(client),
			...(backups ? [dailyBackupCheck(db, backups)] : []),
		]);
	},
} satisfies Event<Events.ClientReady>;
