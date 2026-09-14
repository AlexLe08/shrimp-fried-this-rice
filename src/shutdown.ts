import type { Client } from 'discord.js';
import { stopScheduler } from './scheduler.ts';
import { closeDatabase } from './storage.ts';

let isShuttingDown = false;

export async function shutdown(client: Client, signal: string): Promise<void> {
	// Prevent multiple shutdown attempts if multiple signals are received in quick succession.
    if (isShuttingDown) return;
	isShuttingDown = true;

	console.log(`\nReceived ${signal}, shutting down gracefully...`);

	stopScheduler();

    // Destroy the Discord client to close the WebSocket connection and clean up resources.
    // Use two try/catch blocks to ensure that if one fails, the other still runs, allowing for a more complete shutdown.
	try {
		await client.destroy();
	} catch (error) {
		console.error('Error while destroying the Discord client:', error);
	}

    // Close the database connection to ensure all pending writes are flushed and resources are released.
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