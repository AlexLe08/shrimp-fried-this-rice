import { Client, Collection } from 'discord.js';
import 'dotenv/config';

import { clientOptions } from './core/clientOptions.ts';
import { shutdown } from './core/shutdown.ts';
import { toEventListener } from './core/eventListener.ts';
import { findAreaModules, loadCommands } from './core/loadCommands.ts';
import type { Event } from './core/types/event.ts';
import { dashboardPortFromEnv, startDashboard } from './dashboard/server.ts';
import { authConfigFromEnv } from './dashboard/auth.ts';
import { createAnnouncer, postWithWebhook } from './minecraft/announcement.ts';

const client = new Client(clientOptions);

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
	const event = ((await import(fileUrl)) as { default: Event }).default;
	const listener = toEventListener(event.name, event.execute);
	if (event.once) {
		client.once(event.name, listener);
	} else {
		client.on(event.name, listener);
	}
}

client.cooldowns = new Collection();

const dashboardPort = dashboardPortFromEnv(process.env);
if (dashboardPort !== null)
	void startDashboard(dashboardPort, {
		auth: authConfigFromEnv(process.env),
		client,
		announcer: createAnnouncer({ post: postWithWebhook }),
	});

// A failed login (bad token, Discord down) exits nonzero; systemd restarts it.
client.login(process.env['DISCORD_TOKEN']).catch((error: unknown) => {
	console.error('Login failed:', error);
	process.exit(1);
});

// SIGTERM: systemctl stop/restart (every deploy). SIGINT: Ctrl+C locally.
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
