import { Client, Events } from 'discord.js';
import { startScheduler } from '../../reminders/scheduler.ts';

export default {
	name: Events.ClientReady,
	once: true,
	execute(client: Client<true>) {
		// The deploy job waits for this exact line to confirm the bot logged in.
		console.log(`Ready! Logged in as ${client.user.tag}`);
		startScheduler(client);
	},
};
