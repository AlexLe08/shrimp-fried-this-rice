import { Client, Collection, GatewayIntentBits } from "discord.js";
import 'dotenv/config';

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import type { Command } from "./types/command.ts";

import { shutdown } from "./shutdown.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

function handleShutdownSignal(signal: string): void {
	// A stuck cleanup (a Discord call hanging) would otherwise hold up a restart,
	// and so a deploy, until systemd's 90-second stop timeout kills the process.
	const forceExitTimer = setTimeout(() => {
		console.error('Graceful shutdown timed out, forcing exit.');
		process.exit(1);
	}, 5000);
	forceExitTimer.unref();

	void shutdown(client, signal).then(() => {
		clearTimeout(forceExitTimer);
		process.exit(0);
	});
}

// Every .ts file under commands/<category>/ is a command (deploy-commands.ts
// registers the same set).
for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.ts'));

	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const commandModule = await import(filePath) as { default: Command };
		const command = commandModule.default;
		if (command && 'data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
		} else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.ts'));

for (const file of eventFiles) {
	const filePath = path.join(eventsPath, file);
	const eventModule = await import(filePath) as { default: { name: string; once: boolean; execute: (...args: unknown[]) => Promise<void> } };
	const event = eventModule.default;
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	} else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

client.cooldowns = new Collection();

client.login(process.env["DISCORD_TOKEN"]);

// SIGTERM: systemctl stop/restart (every deploy). SIGINT: Ctrl+C locally.
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
