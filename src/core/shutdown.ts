import type { Client } from 'discord.js';
import { stopScheduler } from './scheduler.ts';
import { closeDatabase } from './database.ts';

let isShuttingDown = false;

export async function shutdown(client: Client, signal: string): Promise<void> {
	// A second signal (Ctrl+C twice, or SIGTERM during SIGINT) is ignored.
	if (isShuttingDown) return;
	isShuttingDown = true;

	console.log(`\nReceived ${signal}, shutting down gracefully...`);

	// Waits for a send already under way, which still needs the client to
	// finish and the database to record it; otherwise the reminder is sent
	// again after the restart.
	await stopScheduler();

	// Separate try blocks: the database still closes if destroying the client fails.
	try {
		await client.destroy();
	} catch (error) {
		console.error('Error while destroying the Discord client:', error);
	}

	try {
		closeDatabase();
	} catch (error) {
		console.error('Error while closing the database:', error);
	}

	console.log('Shutdown complete.');
}

/** Test-only: resets the shutdown guard between tests. Not used in application code. */
export function __resetShutdownStateForTests(): void {
	isShuttingDown = false;
}
