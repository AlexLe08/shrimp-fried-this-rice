import { Client, Collection, GatewayIntentBits } from 'discord.js';
import 'dotenv/config';

import { shutdown } from './core/shutdown.ts';
import { toEventListener } from './core/eventListener.ts';
import { findAreaModules, loadCommands } from './core/loadCommands.ts';

// GuildExpressions keeps each server's emoji current after startup, so an
// emoji added since then isn't warned about as one the bot can't use.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions] });

client.commands = new Collection();

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

for (const command of await loadCommands()) {
	client.commands.set(command.data.name, command);
}

for (const fileUrl of findAreaModules('events')) {
	const eventModule = (await import(fileUrl)) as {
		default: { name: string; once: boolean; execute: (...args: unknown[]) => Promise<void> };
	};
	const event = eventModule.default;
	const listener = toEventListener(event.name, event.execute);
	if (event.once) {
		client.once(event.name, listener);
	} else {
		client.on(event.name, listener);
	}
}

client.cooldowns = new Collection();

// A failed login (bad token, Discord down) exits nonzero; systemd restarts it.
client.login(process.env['DISCORD_TOKEN']).catch((error: unknown) => {
	console.error('Login failed:', error);
	process.exit(1);
});

// SIGTERM: systemctl stop/restart (every deploy). SIGINT: Ctrl+C locally.
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
