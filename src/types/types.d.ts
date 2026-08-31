import { Collection } from 'discord.js';
import type { Command } from './command.ts';


// declare module only augments the shape of things already exported by discord.js itself (like adding commands/cooldowns onto Client). It does not create a new globally-available type named Command that the rest of your project can reference by name — Command still needs to be a real interface that's explicitly defined and explicitly imported anywhere you use it, exactly like any other custom type in your codebase.
// syntax looks like it's doing something global/magic, but it's really just extending an existing module's exported types — anything referenced inside that block (like Command) still follows completely normal TypeScript import/export rules everywhere else.
declare module 'discord.js' {
	export interface Client {
		commands: Collection<string, Command>;
        cooldowns: Collection<string, Collection<string, number>>;
	}
}