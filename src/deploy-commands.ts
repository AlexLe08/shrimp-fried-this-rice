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
    // Grab all the command files from the commands directory you created earlier
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.ts'))
	// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const commandModule = await import(pathToFileURL(filePath).href) as { default: Command};
        const command = commandModule.default;

        if (command && 'data' in command && 'execute' in command) {
            commands.push(command.data.toJSON());
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}

//TODO: Move error handling to separate file for export and import into this file.
if (!process.env['DISCORD_TOKEN']) {
    throw new Error('DISCORD_TOKEN is not defined.');
}

if (!process.env['DISCORD_CLIENT_ID']) {
    throw new Error('DISCORD_CLIENT_ID is not defined.');
}

if (!process.env['DISCORD_GUILD_ID']) {
    throw new Error('DISCORD_GUILD_ID is not defined.');
}
// Construct and prepare an instance of the REST module
const rest = new REST().setToken(process.env['DISCORD_TOKEN']);

// Deploy your commands
try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);
	// The put method is used to fully refresh all commands in the guild with the current set
    const data = await rest.put(
        Routes.applicationCommands(process.env['DISCORD_CLIENT_ID']),
        { body: commands },
    ) as unknown[];

    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
} catch(error) {
    console.error(error);
}
