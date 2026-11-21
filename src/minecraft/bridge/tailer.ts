import { open, type FileHandle } from 'node:fs/promises';

export interface TailerOptions {
	path: string;
	/** Complete lines appended since the last poll, without their `\n`. */
	onLines(lines: string[]): void;
	/**
	 * The file's content when the tailer first finds it, once, never posted:
	 * the helper scans it to learn whether the server is already up. Not
	 * called for a file that appears or is replaced later, whose lines go to
	 * `onLines` from the start.
	 */
	onBacklog?(text: string): void;
	/** A read that failed for a reason other than the file being missing. */
	onError?(error: unknown): void;
	/** Defaults to 500 ms. */
	intervalMs?: number;
}

export interface Tailer {
	/** Reads whatever was appended since the last poll. `start` calls this on a timer. */
	poll(): Promise<void>;
	start(): void;
	/** Stops the timer and waits for a poll under way. */
	stop(): Promise<void>;
}

// A poll reads at most this much, so a log that grew by gigabytes while the
// helper was down can't take its memory; the rest is read on later polls.
const MAX_READ_BYTES = 1024 * 1024;
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
	let stopped = false;

	function emit(bytes: Buffer, final: boolean): string[] {
		const data = partial.length ? Buffer.concat([partial, bytes]) : bytes;
		const lines: string[] = [];
		let start = 0;
		for (let index = data.indexOf(NEWLINE); index !== -1; index = data.indexOf(NEWLINE, start)) {
			lines.push(data.toString('utf8', start, index));
			start = index + 1;
		}
		partial = data.subarray(start);
		if (final && partial.length) {
			lines.push(partial.toString('utf8'));
			partial = Buffer.alloc(0);
		}
		return lines;
	}

	async function poll(): Promise<void> {
		let handle;
		try {
			handle = await open(options.path, 'r');
		} catch (error) {
			// Vanilla renames latest.log on startup and creates a new one, so a
			// missing file is a gap between the two; whatever appears is read from
			// its start.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				const rest = emit(Buffer.alloc(0), true);
				if (rest.length) options.onLines(rest);
				started = true;
				inode = null;
				offset = 0;
				return;
			}
			throw error;
		}
		// Opened per poll and closed after, as an open handle on Windows can stop
		// the server renaming the file.
		try {
			const stats = await handle.stat({ bigint: true });
			const size = Number(stats.size);

			// A new inode is a replaced file, which may already have grown past the
			// old offset; a smaller size is one truncated in place.
			if (inode !== null && (stats.ino !== inode || size < offset)) {
				const rest = emit(Buffer.alloc(0), true);
				if (rest.length) options.onLines(rest);
				offset = 0;
			}
			inode = stats.ino;

			if (!started) {
				started = true;
				// Old history is never replayed: the backlog is only scanned. A
				// partial last line is kept for `onLines` to complete.
				const backlog = await readFrom(handle, 0, size);
				offset = size;
				const lines = emit(backlog, false);
				options.onBacklog?.(lines.join('\n'));
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

	function guardedPoll(): Promise<void> {
		running = poll()
			.catch((error: unknown) => options.onError?.(error))
			.finally(() => {
				running = null;
			});
		return running;
	}

	function schedule(): void {
		if (stopped) return;
		timer = setTimeout(() => {
			timer = null;
			void guardedPoll().then(schedule);
		}, intervalMs);
	}

	return {
		poll,
		start() {
			stopped = false;
			void guardedPoll().then(schedule);
		},
		async stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
			await running;
		},
	};
}

async function readFrom(handle: FileHandle, position: number, length: number) {
	const buffer = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
		if (bytesRead === 0) break;
		read += bytesRead;
	}
	return buffer.subarray(0, read);
}
