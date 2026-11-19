import { REST, Routes } from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import 'dotenv/config';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from './types/command.ts';

const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.ts'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const commandModule = (await import(pathToFileURL(filePath).href)) as { default: Command };
		const command = commandModule.default;

		if (command && 'data' in command && 'execute' in command) {
			commands.push(command.data.toJSON());
		} else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

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
