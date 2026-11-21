import { appendFile, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTailer, MAX_READ_BYTES } from '../../../src/minecraft/bridge/tailer.ts';

let dir: string;
let path: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'mcbridge-tailer-'));
	path = join(dir, 'latest.log');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function setup() {
	const lines: string[] = [];
	const backlog = vi.fn<(text: string) => void>();
	const onError = vi.fn();
	const tailer = createTailer({ path, onLines: (batch) => lines.push(...batch), onBacklog: backlog, onError });
	return { tailer, lines, backlog, onError };
}

describe('createTailer', () => {
	it('hands the existing content to onBacklog once and never replays it', async () => {
		await writeFile(path, 'old one\nold two\n');
		const { tailer, lines, backlog } = setup();
		await tailer.poll();
		await tailer.poll();
		expect(backlog).toHaveBeenCalledOnce();
		expect(backlog).toHaveBeenCalledWith('old one\nold two');
		expect(lines).toEqual([]);
	});

	it('reads lines appended after startup', async () => {
		await writeFile(path, 'old\n');
		const { tailer, lines } = setup();
		await tailer.poll();
		await appendFile(path, 'new one\nnew two\n');
		await tailer.poll();
		expect(lines).toEqual(['new one', 'new two']);
	});

	it('holds a partial line until its newline arrives', async () => {
		await writeFile(path, '');
		const { tailer, lines } = setup();
		await tailer.poll();
		await appendFile(path, '[12:00:00] [Server thread/INFO]: hal');
		await tailer.poll();
		expect(lines).toEqual([]);
		await appendFile(path, 'f done\n');
		await tailer.poll();
		expect(lines).toEqual(['[12:00:00] [Server thread/INFO]: half done']);
	});

	it('completes a partial last line of the backlog through onLines', async () => {
		await writeFile(path, 'old\nhal');
		const { tailer, lines, backlog } = setup();
		await tailer.poll();
		expect(backlog).toHaveBeenCalledWith('old');
		await appendFile(path, 'f\n');
		await tailer.poll();
		expect(lines).toEqual(['half']);
	});

	it('decodes a UTF-8 character split across two reads', async () => {
		await writeFile(path, '');
		const { tailer, lines } = setup();
		await tailer.poll();
		const bytes = Buffer.from('<Steve> héllo\n');
		const split = bytes.indexOf(0xc3) + 1;
		await appendFile(path, bytes.subarray(0, split));
		await tailer.poll();
		await appendFile(path, bytes.subarray(split));
		await tailer.poll();
		expect(lines).toEqual(['<Steve> héllo']);
	});

	it('keeps the \\r of a Windows line ending for the parser to strip', async () => {
		await writeFile(path, '');
		const { tailer, lines } = setup();
		await tailer.poll();
		await appendFile(path, 'one\r\n');
		await tailer.poll();
		expect(lines).toEqual(['one\r']);
	});

	it('reads a truncated file from its start', async () => {
		await writeFile(path, 'a long first log line\n');
		const { tailer, lines } = setup();
		await tailer.poll();
		await truncate(path, 0);
		await appendFile(path, 'new\n');
		await tailer.poll();
		expect(lines).toEqual(['new']);
	});

	it('keeps polling while the file is missing and reads the new one from its start', async () => {
		await writeFile(path, 'old\n');
		const { tailer, lines, onError } = setup();
		await tailer.poll();
		await rm(path);
		await tailer.poll();
		await writeFile(path, 'fresh\n');
		await tailer.poll();
		expect(lines).toEqual(['fresh']);
		expect(onError).not.toHaveBeenCalled();
	});

	it('notices a replaced file that already grew past the old offset', async () => {
		// Vanilla's rotation: latest.log is renamed and a new one written, which
		// can outgrow the old one between two polls.
		await writeFile(path, 'old\n');
		const { tailer, lines } = setup();
		await tailer.poll();
		await rename(path, join(dir, '2026-11-21-1.log.gz'));
		await writeFile(path, 'first line of the new log\nsecond\n');
		await tailer.poll();
		expect(lines).toEqual(['first line of the new log', 'second']);
	});

	it('emits the partial last line of a file that was replaced', async () => {
		await writeFile(path, '');
		const { tailer, lines } = setup();
		await tailer.poll();
		await appendFile(path, 'unfinished');
		await tailer.poll();
		await rm(path);
		await tailer.poll();
		expect(lines).toEqual(['unfinished']);
	});

	it('reads a file missing at startup from its start, without a backlog', async () => {
		const { tailer, lines, backlog } = setup();
		await tailer.poll();
		await writeFile(path, 'first\n');
		await tailer.poll();
		expect(lines).toEqual(['first']);
		expect(backlog).not.toHaveBeenCalled();
	});

	it('reads a large append over several polls, losing nothing', async () => {
		await writeFile(path, '');
		const { tailer, lines } = setup();
		await tailer.poll();
		const line = 'x'.repeat(99);
		const count = 15_000; // 1.5 MB, past one poll's 1 MiB
		await appendFile(path, `${line}\n`.repeat(count));
		await tailer.poll();
		expect(lines.length).toBeLessThan(count);
		await tailer.poll();
		expect(lines).toHaveLength(count);
		expect(lines.every((read) => read === line)).toBe(true);
	});

	it('polls on its own once started, and stop waits for the poll under way', async () => {
		await writeFile(path, '');
		const lines: string[] = [];
		const backlog = vi.fn();
		const tailer = createTailer({
			path,
			intervalMs: 10,
			onLines: (batch) => lines.push(...batch),
			onBacklog: backlog,
			onError: vi.fn(),
		});
		tailer.start();
		// Appended before the first poll, the line would be backlog, never replayed.
		await vi.waitFor(() => expect(backlog).toHaveBeenCalled());
		await appendFile(path, 'tick\n');
		await vi.waitFor(() => expect(lines).toEqual(['tick']));
		await tailer.stop();
		await appendFile(path, 'after stop\n');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(lines).toEqual(['tick']);
	});

	it('reports a repeating read error once, and again after it clears and comes back', async () => {
		// A directory where the log should be fails with EISDIR, on open or on
		// read depending on the OS, but never with ENOENT.
		await mkdir(path);
		const { tailer, onError } = setup();
		await tailer.poll();
		await tailer.poll();
		await tailer.poll();
		expect(onError).toHaveBeenCalledOnce();
		await rm(path, { recursive: true });
		await writeFile(path, '');
		await tailer.poll();
		await rm(path);
		await mkdir(path);
		await tailer.poll();
		expect(onError).toHaveBeenCalledTimes(2);
	});

	it('keeps polling when onError throws', async () => {
		await mkdir(path);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const lines: string[] = [];
		const onError = vi.fn(() => {
			throw new Error('callback broke');
		});
		const tailer = createTailer({ path, intervalMs: 10, onLines: (batch) => lines.push(...batch), onError });
		tailer.start();
		await vi.waitFor(() => expect(onError).toHaveBeenCalled());
		await rm(path, { recursive: true });
		await writeFile(path, 'recovered\n');
		await vi.waitFor(() => expect(lines).toEqual(['recovered']));
		await tailer.stop();
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it('joins a poll under way instead of reading the same bytes twice', async () => {
		await writeFile(path, '');
		const { tailer, lines } = setup();
		await tailer.poll();
		await appendFile(path, 'once\n');
		await Promise.all([tailer.poll(), tailer.poll(), tailer.poll()]);
		expect(lines).toEqual(['once']);
	});

	it('runs one timer however often start is called, including during stop', async () => {
		// Only the timers are fake; the file reads are real.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			await writeFile(path, '');
			const { tailer } = setup();
			tailer.start();
			tailer.start();
			await tailer.poll();
			expect(vi.getTimerCount()).toBe(1);

			// A poll still under way when stop and start are called: its chain must
			// not re-arm beside the new one.
			vi.advanceTimersByTime(500);
			const stopping = tailer.stop();
			tailer.start();
			await stopping;
			await tailer.poll();
			expect(vi.getTimerCount()).toBe(1);
			await tailer.stop();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('scans only the last MAX_READ_BYTES of a large file, from a line start', async () => {
		const line = 'y'.repeat(99);
		const count = Math.ceil((MAX_READ_BYTES * 1.5) / 100);
		await writeFile(path, `first\n${`${line}\n`.repeat(count)}last\n`);
		const { tailer, backlog } = setup();
		await tailer.poll();
		const text = backlog.mock.calls[0]![0];
		expect(text.length).toBeLessThanOrEqual(MAX_READ_BYTES);
		expect(text.startsWith(line)).toBe(true);
		expect(text.endsWith('\nlast')).toBe(true);
		expect(text).not.toContain('first');
	});

	it('passes on a line too long to hold rather than buffering it without bound', async () => {
		await writeFile(path, '');
		const { tailer, lines } = setup();
		await tailer.poll();
		await appendFile(path, 'z'.repeat(70 * 1024));
		await tailer.poll();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toHaveLength(70 * 1024);
	});
});
