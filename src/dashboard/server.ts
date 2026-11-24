import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp, type AppOptions } from './app.ts';
import { HelperHub } from '../minecraft/helperHub.ts';

// cloudflared keeps an idle connection to the bot open for 90 s by default;
// were Node to close it first (after 5 s by default), the request cloudflared
// next sends on it would fail with a 502.
export const KEEP_ALIVE_TIMEOUT_MS = 100_000;

// How long shutdown lets requests under way finish before cutting them off:
// a client stuck partway through one would otherwise hold the server open
// past index.ts's 5 s forced exit, which could cut off a reminder mid-send.
export const CLOSE_GRACE_MS = 2000;

const CLOSE_IDLE_EVERY_MS = 50;

let server: Server | null = null;
let helpers: HelperHub | null = null;

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
export function startDashboard(port: number, appOptions: AppOptions = { auth: null }): Promise<number | null> {
	if (server) {
		console.error('The dashboard is already running; not starting it again.');
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		let listening: Server;
		const hub = appOptions.helpers ?? new HelperHub(appOptions.now);
		try {
			listening = startServer(port, { ...appOptions, helpers: hub }, resolve);
		} catch (error) {
			console.error('The dashboard is off: its server failed:', error);
			resolve(null);
			return;
		}
		listening.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
		listening.on('error', (error) => {
			console.error('The dashboard is off: its server failed:', error);
			if (server === listening) {
				server = null;
				helpers = null;
			}
			resolve(null);
		});
		server = listening;
		helpers = hub;
	});
}

function startServer(port: number, appOptions: AppOptions, resolve: (port: number) => void): Server {
	return serve(
		{
			fetch: createApp(appOptions).fetch,
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
}

/**
 * Stops taking requests and waits for those under way, which may still need
 * the client and the database, for up to `graceMs`; then cuts off the rest.
 * The Minecraft helpers' polls, held for up to 50 s, are answered first, so
 * they don't use up the grace and get cut off (decision 0009).
 */
export async function stopDashboard(graceMs = CLOSE_GRACE_MS): Promise<void> {
	const running = server;
	if (!running) return;
	server = null;
	helpers?.close();
	helpers = null;
	await new Promise<void>((resolve) => {
		const cutOff = setTimeout(() => running.closeAllConnections(), graceMs);
		// close() closes only the connections idle at the time; one whose
		// request finishes later (a held poll, answered just above) would stay
		// open on keep-alive until the cut-off, so keep closing those.
		const closeIdle = setInterval(() => running.closeIdleConnections(), CLOSE_IDLE_EVERY_MS);
		running.close((error) => {
			clearTimeout(cutOff);
			clearInterval(closeIdle);
			if (error) console.error('Error while stopping the dashboard:', error);
			resolve();
		});
	});
}

/** Test-only: the running server, if any. Not used in application code. */
export function __dashboardServerForTests(): Server | null {
	return server;
}
