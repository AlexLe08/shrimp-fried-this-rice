import { open, type FileHandle } from 'node:fs/promises';

export interface TailerOptions {
	path: string;
	/** Complete lines appended since the last poll, without their `\n`. */
	onLines(lines: string[]): void;
	/**
	 * The end of the file's content when the tailer first finds it (up to
	 * `MAX_READ_BYTES`, from a line start), once, never posted: the helper
	 * scans it to learn whether the server is already up. Not called for a
	 * file that appears or is replaced later, whose lines go to `onLines` from
	 * the start.
	 */
	onBacklog?(text: string): void;
	/**
	 * A read that failed for a reason other than the file being missing.
	 * Reported once until the error changes or a read succeeds, as the same
	 * failure (a wrong path, no permission) would otherwise repeat every poll.
	 */
	onError(error: unknown): void;
	/** Defaults to 500 ms. */
	intervalMs?: number;
}

export interface Tailer {
	/** Reads whatever was appended since the last poll, or joins the poll under way. Never rejects. */
	poll(): Promise<void>;
	/** Polls every `intervalMs`; does nothing if already started. */
	start(): void;
	/** Stops the timer and waits for a poll under way. */
	stop(): Promise<void>;
}

// A poll reads at most this much, so a log that grew by gigabytes while the
// helper was down can't take its memory; the rest is read on later polls.
// The backlog is cut to it too: knowing whether the server is up needs only
// the last start or stop line, and latest.log rotates only on a restart, so
// a server up for weeks can leave hundreds of megabytes.
export const MAX_READ_BYTES = 1024 * 1024;
// A line longer than this (a file with no newlines, written to the wrong
// path, say) is passed on as it is rather than held without bound.
const MAX_LINE_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

export function createTailer(options: TailerOptions): Tailer {
	const intervalMs = options.intervalMs ?? 500;
	let offset = 0;
	let inode: bigint | null = null;
	let started = false;
	// Bytes after the last newline. Kept as bytes so a UTF-8 character split
	// across two reads is decoded whole.
	let partial: Buffer = Buffer.alloc(0);
	let timer: NodeJS.Timeout | null = null;
	let running: Promise<void> | null = null;
	let active = false;
	// Each start() begins a new chain; a poll from an older one doesn't re-arm.
	let generation = 0;
	let lastError: string | null = null;

	function emit(bytes: Buffer, final: boolean): string[] {
		const data = partial.length ? Buffer.concat([partial, bytes]) : bytes;
		const lines: string[] = [];
		let start = 0;
		for (let index = data.indexOf(NEWLINE); index !== -1; index = data.indexOf(NEWLINE, start)) {
			lines.push(data.toString('utf8', start, index));
			start = index + 1;
		}
		partial = data.subarray(start);
		if ((final || partial.length > MAX_LINE_BYTES) && partial.length) {
			lines.push(partial.toString('utf8'));
			partial = Buffer.alloc(0);
		}
		return lines;
	}

	function finishOldFile(): void {
		const rest = emit(Buffer.alloc(0), true);
		if (rest.length) options.onLines(rest);
		offset = 0;
	}

	async function read(): Promise<void> {
		let handle;
		try {
			handle = await open(options.path, 'r');
		} catch (error) {
			// Vanilla renames latest.log on startup and creates a new one, so a
			// missing file is a gap between the two; whatever appears is read from
			// its start.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				finishOldFile();
				started = true;
				inode = null;
				return;
			}
			throw error;
		}
		// Opened by path on every poll, so after a rotation the new latest.log is
		// read, not the renamed old one a held handle would still point at.
		try {
			const stats = await handle.stat({ bigint: true });
			const size = Number(stats.size);

			// A new inode is a replaced file, which may already have grown past the
			// old offset; a smaller size is one truncated in place. Some
			// filesystems (some Docker Desktop and network mounts) report inode 0
			// for every file, leaving only the size check.
			if (inode !== null && (stats.ino !== inode || size < offset)) finishOldFile();
			inode = stats.ino;

			if (!started) {
				started = true;
				const from = Math.max(0, size - MAX_READ_BYTES);
				let backlog = await readFrom(handle, from, size - from);
				offset = from + backlog.length;
				// Cut mid-file: the first line is a fragment, so start after it.
				if (from > 0) backlog = backlog.subarray(backlog.indexOf(NEWLINE) + 1);
				// A partial last line is kept for `onLines` to complete.
				options.onBacklog?.(emit(backlog, false).join('\n'));
				return;
			}

			if (size <= offset) return;
			const bytes = await readFrom(handle, offset, Math.min(size - offset, MAX_READ_BYTES));
			offset += bytes.length;
			const lines = emit(bytes, false);
			if (lines.length) options.onLines(lines);
		} finally {
			await handle.close();
		}
	}

	function poll(): Promise<void> {
		running ??= read()
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
					console.error('[mcbridge] the tailer onError callback threw:', callbackError);
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

async function readFrom(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
		if (bytesRead === 0) break;
		read += bytesRead;
	}
	return buffer.subarray(0, read);
}
