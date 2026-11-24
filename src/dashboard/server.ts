import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

// cloudflared keeps an idle connection to the bot open for 90 s by default;
// were Node to close it first (after 5 s by default), the request cloudflared
// next sends on it would fail with a 502.
export const KEEP_ALIVE_TIMEOUT_MS = 100_000;

let server: Server | null = null;

/** DASHBOARD_PORT from `.env`, or null when unset (a dev bot) or malformed (logged). */
export function dashboardPortFromEnv(env: NodeJS.ProcessEnv): number | null {
	const value = env['DASHBOARD_PORT'];
	if (!value) return null;
	const port = Number(value);
	if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
		console.error('The dashboard is off: DASHBOARD_PORT in .env must be a port number, 1 to 65535.');
		return null;
	}
	return port;
}

/**
 * Serves the dashboard on 127.0.0.1, where only cloudflared on the VM reaches
 * it (decision 0008). Resolves with the port once listening, or null if the
 * server failed, logged: the bot runs on without its dashboard rather than
 * leaving every server without reminders.
 */
export function startDashboard(port: number): Promise<number | null> {
	return new Promise((resolve) => {
		const listening = serve(
			{
				fetch: createApp().fetch,
				port,
				hostname: '127.0.0.1',
				// Otherwise it swaps the process's global Request and Response for its
				// own, under every other fetch in the bot (discord.js, off-VM backups).
				overrideGlobalObjects: false,
			},
			(info) => {
				console.log(`Dashboard listening on http://127.0.0.1:${info.port}`);
				resolve(info.port);
			},
		) as Server;
		listening.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
		listening.on('error', (error) => {
			console.error('The dashboard is off: its server failed:', error);
			if (server === listening) server = null;
			resolve(null);
		});
		server = listening;
	});
}

/** Stops taking requests and waits for those under way, which may still need the client and the database. */
export async function stopDashboard(): Promise<void> {
	const running = server;
	if (!running) return;
	server = null;
	await new Promise<void>((resolve) => {
		running.close((error) => {
			if (error) console.error('Error while stopping the dashboard:', error);
			resolve();
		});
	});
}

/** Test-only: the running server, if any. Not used in application code. */
export function __dashboardServerForTests(): Server | null {
	return server;
}
