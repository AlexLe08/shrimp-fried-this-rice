import { REST, Routes } from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import 'dotenv/config';
import { loadCommands } from './core/loadCommands.ts';

const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = (await loadCommands()).map((command) =>
	command.data.toJSON(),
);

if (!process.env['DISCORD_TOKEN']) {
	throw new Error('DISCORD_TOKEN is not defined.');
}

if (!process.env['DISCORD_CLIENT_ID']) {
	throw new Error('DISCORD_CLIENT_ID is not defined.');
}

const rest = new REST().setToken(process.env['DISCORD_TOKEN']);

try {
	console.log(`Started refreshing ${commands.length} application (/) commands.`);
	// PUT replaces the whole global set, so a command deleted from the code
	// disappears for users too.
	const data = (await rest.put(Routes.applicationCommands(process.env['DISCORD_CLIENT_ID']), {
		body: commands,
	})) as unknown[];

	console.log(`Successfully reloaded ${data.length} application (/) commands.`);
} catch (error) {
	console.error(error);
	// The deploy job runs this after restarting the bot; a nonzero exit fails
	// the job, so a registration that didn't happen can't pass as a green deploy.
	process.exitCode = 1;
}
