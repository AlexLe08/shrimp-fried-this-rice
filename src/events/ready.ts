import { Client, Events } from 'discord.js';
import { startScheduler } from '../scheduler.ts';

export default {
    name: Events.ClientReady,
    once: true,
    execute(client: Client<true>) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        startScheduler(client);
    },
}