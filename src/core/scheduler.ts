/** How often every check runs. Should be <= the smallest reminder interval (5 min). */
const POLL_INTERVAL_MS = 60_000;

/**
 * Work the scheduler runs every poll, such as sending due reminders. A
 * check closes over whatever client it needs, so the scheduler stays free of
 * each area's types.
 */
export interface ScheduledCheck {
	/** Names the check in its failure log: `${name} check failed:`. */
	name: string;
	/**
	 * Aborted by stopScheduler: finish the send under way and skip the rest of
	 * the batch; it's still due after the restart.
	 */
	run(signal: AbortSignal): Promise<void>;
}

let pollIntervalID: NodeJS.Timeout | null = null;
let controller = new AbortController();
// Each check started by an earlier poll, while it runs. A poll that finds a
// check still running skips it, so a check never overlaps itself, and
// stopScheduler waits for them so shutdown doesn't close the database under
// a send.
const running = new Map<ScheduledCheck, Promise<void>>();

// A check that throws (the database failing, say) is logged rather than
// left as an unhandled rejection, which would crash the process.
async function runCheck(check: ScheduledCheck, signal: AbortSignal): Promise<void> {
	try {
		await check.run(signal);
	} catch (error) {
		console.error(`${check.name} check failed:`, error);
	}
}

// Started from the ClientReady event, so the client is logged in.
export function startScheduler(checks: readonly ScheduledCheck[]): void {
	controller = new AbortController();
	const { signal } = controller;
	pollIntervalID = setInterval(() => {
		for (const check of checks) {
			if (running.has(check)) continue;
			running.set(
				check,
				runCheck(check, signal).finally(() => running.delete(check)),
			);
		}
	}, POLL_INTERVAL_MS);

	console.log(`Scheduler started, polling every ${POLL_INTERVAL_MS / 1000}s.`);
}

/** Stops polling, then resolves once any check already running has finished. */
export async function stopScheduler(): Promise<void> {
	controller.abort();
	if (pollIntervalID) {
		clearInterval(pollIntervalID);
		pollIntervalID = null;
	}
	await Promise.all(running.values());
	console.log('Scheduler stopped.');
}
