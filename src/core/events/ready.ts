import { Client, Events } from 'discord.js';
import type { Event } from '../types/event.ts';
import { startScheduler } from '../scheduler.ts';
import { dueReminderChecks } from '../../reminders/dueReminders.ts';
import { recruitFollowUpCheck } from '../../ffxiv/recruit/followUps.ts';
import { backupDirectory, db } from '../database.ts';
import { dailyBackupCheck } from '../backup.ts';
import { offsiteBackupCheckFromEnv, ownerNotifier } from '../offsiteBackup.ts';

export default {
	name: Events.ClientReady,
	once: true,
	execute(client: Client<true>) {
		// The deploy job waits for this exact line to confirm the bot logged in.
		console.log(`Ready! Logged in as ${client.user.tag}`);
		const backups = backupDirectory();
		// The scheduler starts each poll's checks without waiting, but the daily
		// check saves synchronously, so this one, started after it, sees its
		// snapshot in the same poll.
		const offsite = backups && offsiteBackupCheckFromEnv(process.env, backups, ownerNotifier(client));
		startScheduler([
			...dueReminderChecks(client),
			recruitFollowUpCheck(client),
			...(backups ? [dailyBackupCheck(db, backups)] : []),
			...(offsite ? [offsite] : []),
		]);
	},
} satisfies Event<Events.ClientReady>;
