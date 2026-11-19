import { Collection } from 'discord.js';
import type { Command } from './command.ts';

// index.ts attaches these to the client at startup.
declare module 'discord.js' {
	export interface Client {
		commands: Collection<string, Command>;
		cooldowns: Collection<string, Collection<string, number>>;
	}
}
