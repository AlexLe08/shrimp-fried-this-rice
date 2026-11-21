import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface CrashReport {
	/** The report's `Description:` line ("Exception in server tick loop", say), or null if it has none. */
	description: string | null;
	/** The exception under the description and its stack trace, up to the first blank line. */
	exception: string[];
}

// The exception's message and its first frames say what broke; the rest of a
// trace this long wouldn't fit in a Discord message anyway.
const MAX_EXCEPTION_LINES = 40;

/**
 * The parts of a vanilla crash report worth posting: `---- Minecraft Crash
 * Report ----`, a joke comment, `Time:`, `Description:`, a blank line, then
 * the exception and its trace. Everything after (the "detailed walkthrough"
 * and system details) is left in the file.
 */
export function parseCrashReport(text: string): CrashReport {
	const lines = text.replace(/\r/g, '').split('\n');
	const at = lines.findIndex((line) => line.startsWith('Description: '));
	if (at === -1) return { description: null, exception: [] };
	const description = lines[at]!.slice('Description: '.length).trim() || null;
	let start = at + 1;
	while (start < lines.length && lines[start]!.trim() === '') start++;
	const exception: string[] = [];
	for (let index = start; index < lines.length && lines[index]!.trim() !== ''; index++) {
		if (exception.length === MAX_EXCEPTION_LINES) break;
		exception.push(lines[index]!);
	}
	return { description, exception };
}

export interface CrashWatcherOptions {
	dir: string;
	/** A report that appeared since the helper started: its file name and the start of its text. */
	onReport(file: string, text: string): void;
	/**
	 * Listing the folder failed for a reason other than it being missing.
	 * Reported once until the error changes or a listing succeeds, like the
	 * tailer's read errors.
	 */
	onError(error: unknown): void;
	/** Defaults to 5 s: a crash isn't chat, and the server takes longer than that to restart. */
	intervalMs?: number;
}

export interface CrashWatcher {
	/** Checks the folder once, or joins the check under way. Never rejects. */
	poll(): Promise<void>;
	start(): void;
	/** Stops the timer and waits for a check under way. */
	stop(): Promise<void>;
}

// The top of a report holds everything posted; the system details below it
// can run to hundreds of kilobytes with many mods.
const MAX_REPORT_BYTES = 64 * 1024;

/**
 * Watches a crash-reports folder by listing it on a timer (not `fs.watch`,
 * which behaves differently on each OS, as with the log). Reports already
 * there when it starts are never posted.
 */
export function createCrashWatcher(options: CrashWatcherOptions): CrashWatcher {
	const intervalMs = options.intervalMs ?? 5000;
	let ready = false;
	// Reports posted, or there before the helper started.
	const seen = new Set<string>();
	// New reports, by their size at the last check: one is read only once its
	// size holds still, so a report still being written isn't posted cut short.
	const growing = new Map<string, number>();
	let timer: NodeJS.Timeout | null = null;
	let running: Promise<void> | null = null;
	let active = false;
	// Each start() begins a new chain; a check from an older one doesn't re-arm.
	let generation = 0;
	let lastError: string | null = null;

	async function list(): Promise<string[]> {
		try {
			return (await readdir(options.dir)).filter((name) => name.endsWith('.txt'));
		} catch (error) {
			// No folder until the server first crashes.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
	}

	async function check(): Promise<void> {
		const names = await list();
		// Only after a listing that worked: otherwise a folder unreadable at
		// startup would have every old report posted once it became readable.
		if (!ready) {
			for (const name of names) seen.add(name);
			ready = true;
			return;
		}
		const present = new Set(names);
		// Forget deleted reports, so the sets don't grow for as long as the helper runs.
		for (const name of seen) if (!present.has(name)) seen.delete(name);
		for (const name of growing.keys()) if (!present.has(name)) growing.delete(name);

		for (const name of names) {
			if (seen.has(name)) continue;
			const path = join(options.dir, name);
			let size: number;
			try {
				size = (await stat(path)).size;
			} catch {
				continue; // Deleted between the listing and now.
			}
			if (size === 0 || growing.get(name) !== size) {
				growing.set(name, size);
				continue;
			}
			growing.delete(name);
			seen.add(name);
			let text: string;
			try {
				text = await readStart(path);
			} catch (error) {
				// Still worth posting: the owner learns the server crashed, and where to look.
				text = '';
				console.error(`[mcbridge] can't read ${path}:`, error);
			}
			options.onReport(name, text);
		}
	}

	function poll(): Promise<void> {
		running ??= check()
			.then(() => {
				lastError = null;
			})
			.catch((error: unknown) => {
				const key = String((error as NodeJS.ErrnoException).code ?? error);
				if (key === lastError) return;
				lastError = key;
				try {
					options.onError(error);
				} catch (callbackError) {
					console.error('[mcbridge] the crash watcher onError callback threw:', callbackError);
				}
			})
			.finally(() => {
				running = null;
			});
		return running;
	}

	function schedule(chain: number): void {
		if (!active || chain !== generation) return;
		timer = setTimeout(() => {
			timer = null;
			void poll().then(() => schedule(chain));
		}, intervalMs);
	}

	return {
		poll,
		start() {
			if (active) return;
			active = true;
			const chain = ++generation;
			void poll().then(() => schedule(chain));
		},
		async stop() {
			active = false;
			if (timer) clearTimeout(timer);
			timer = null;
			await running;
		},
	};
}

async function readStart(path: string): Promise<string> {
	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(MAX_REPORT_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, MAX_REPORT_BYTES, 0);
		return buffer.toString('utf8', 0, bytesRead);
	} finally {
		await handle.close();
	}
}
