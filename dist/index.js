import { Client, Collection, GatewayIntentBits } from "discord.js";
import 'dotenv/config';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
// reads the path to the directory and returns an array of all the folder names it contains
const commandFolders = fs.readdirSync(foldersPath);
//Command handler: reads the path to each folder and returns an array of all the file names they contain, then imports each command file and adds it to the client's commands collection.
for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    // reads the path to this directory and returns an array of all the file names they contain,
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.ts'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        // always false; data/execute are under command.default
        // const command = await import (filePath);
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const commandModule = await import(filePath);
            const command = commandModule.default;
            // Set a new item in the Collection with the key as the command name and the value as the exported module
            // For each file being loaded, check that it has at least the data and execute properties.
            if (command && 'data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
            }
            else {
                console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
            }
        }
    }
}
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.ts'));
// Event handler: reads the path to the events directory and returns an array of all the file names it contains, then imports each event file and registers it with the client.
for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    // Commonjs syntax for importing modules dynamically at runtime, but in ES modules, you can use the import() function to achieve the same effect. The import() function returns a promise that resolves to the module object, which you can then use to access the exported members of the module.
    // const event = require(filePath);
    // const event = await import(filePath);
    const eventModule = await import(filePath);
    const event = eventModule.default;
    // The once property is a boolean that indicates whether the event should be registered as a one-time event listener (true) or a persistent event listener (false). If once is true, the event listener will be removed after it is triggered for the first time. If once is false, the event listener will remain active and continue to listen for events until it is explicitly removed.
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args));
    }
    else {
        client.on(event.name, (...args) => event.execute(...args));
    }
}
client.cooldowns = new Collection();
client.login(process.env.DISCORD_TOKEN);
//# sourceMappingURL=index.js.map