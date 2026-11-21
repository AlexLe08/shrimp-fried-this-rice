import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrashWatcher, parseCrashReport } from '../../../src/minecraft/bridge/crashReports.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'vanilla-synthetic-crash-report.txt');

describe('parseCrashReport', () => {
	it("takes the description and the exception's trace, and leaves the system details", async () => {
		expect(parseCrashReport(await readFile(FIXTURE, 'utf8'))).toEqual({
			description: 'Exception in server tick loop',
			exception: [
				'java.lang.IllegalStateException: Example failure',
				'\tat net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:1000)',
				'\tat net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:900)',
				'\tat java.base/java.lang.Thread.run(Thread.java:1583)',
			],
		});
	});

	it('reads a report saved with Windows line endings', () => {
		expect(parseCrashReport('Description: Watching Server\r\n\r\njava.lang.Error: hung\r\n\tat a\r\n')).toEqual({
			description: 'Watching Server',
			exception: ['java.lang.Error: hung', '\tat a'],
		});
	});

	it('keeps at most 40 lines of the trace', () => {
		const frames = Array.from({ length: 100 }, (_, index) => `\tat Frame${index}`);
		const { exception } = parseCrashReport(['Description: x', '', 'java.lang.Error', ...frames].join('\n'));
		expect(exception).toHaveLength(40);
		expect(exception[0]).toBe('java.lang.Error');
	});

	it('has no description for a file that is not a crash report', () => {
		expect(parseCrashReport('notes\n')).toEqual({ description: null, exception: [] });
		expect(parseCrashReport('')).toEqual({ description: null, exception: [] });
	});
});

describe('createCrashWatcher', () => {
	let root: string;
	let dir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mcbridge-crash-'));
		dir = join(root, 'crash-reports');
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function setup() {
		const onReport = vi.fn<(file: string, text: string) => void>();
		const onError = vi.fn();
		const watcher = createCrashWatcher({ dir, onReport, onError });
		return { watcher, onReport, onError };
	}

	it('never posts reports that were there when it started', async () => {
		await mkdir(dir);
		await writeFile(join(dir, 'crash-old-server.txt'), 'Description: old\n');
		const { watcher, onReport } = setup();
		await watcher.poll();
		await watcher.poll();
		await watcher.poll();
		expect(onReport).not.toHaveBeenCalled();
	});

	it('posts a new report once its size holds still, and only once', async () => {
		await mkdir(dir);
		const { watcher, onReport } = setup();
		await watcher.poll();
		const text = await readFile(FIXTURE, 'utf8');
		await writeFile(join(dir, 'crash-new-server.txt'), text);
		await watcher.poll();
		expect(onReport).not.toHaveBeenCalled();
		await watcher.poll();
		expect(onReport).toHaveBeenCalledExactlyOnceWith('crash-new-server.txt', text);
		await watcher.poll();
		expect(onReport).toHaveBeenCalledOnce();
	});

	it('waits while a report is still being written', async () => {
		await mkdir(dir);
		const { watcher, onReport } = setup();
		await watcher.poll();
		const path = join(dir, 'crash-new-server.txt');
		await writeFile(path, '');
		await watcher.poll();
		await watcher.poll();
		expect(onReport).not.toHaveBeenCalled();
		await writeFile(path, 'Description: half');
		await watcher.poll();
		await writeFile(path, 'Description: half written, now whole\n');
		await watcher.poll();
		expect(onReport).not.toHaveBeenCalled();
		await watcher.poll();
		expect(onReport).toHaveBeenCalledExactlyOnceWith('crash-new-server.txt', 'Description: half written, now whole\n');
	});

	it('treats a missing folder as empty, so the first crash after it appears is posted', async () => {
		const { watcher, onReport, onError } = setup();
		await watcher.poll();
		await mkdir(dir);
		await writeFile(join(dir, 'crash-first-server.txt'), 'Description: first\n');
		await watcher.poll();
		await watcher.poll();
		expect(onReport).toHaveBeenCalledOnce();
		expect(onError).not.toHaveBeenCalled();
	});

	it('ignores files other than .txt', async () => {
		await mkdir(dir);
		const { watcher, onReport } = setup();
		await watcher.poll();
		await writeFile(join(dir, 'notes.md'), 'x');
		await watcher.poll();
		await watcher.poll();
		expect(onReport).not.toHaveBeenCalled();
	});

	it('reports a folder it cannot list once, and posts nothing that was there before it could', async () => {
		// A file where the folder should be: listing it fails with ENOTDIR on every OS.
		await writeFile(dir, '');
		const { watcher, onReport, onError } = setup();
		await watcher.poll();
		await watcher.poll();
		expect(onError).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'ENOTDIR' });

		await rm(dir);
		await mkdir(dir);
		await writeFile(join(dir, 'crash-old-server.txt'), 'Description: old\n');
		await watcher.poll();
		await watcher.poll();
		await watcher.poll();
		expect(onReport).not.toHaveBeenCalled();
	});

	it('polls on a timer once started, and stops', async () => {
		await mkdir(dir);
		const onReport = vi.fn();
		const watcher = createCrashWatcher({ dir, onReport, onError: vi.fn(), intervalMs: 10 });
		watcher.start();
		watcher.start();
		await vi.waitFor(async () => {
			await writeFile(join(dir, 'crash-new-server.txt'), 'Description: x\n');
			expect(onReport).toHaveBeenCalledOnce();
		});
		await watcher.stop();
		await writeFile(join(dir, 'crash-later-server.txt'), 'Description: y\n');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(onReport).toHaveBeenCalledOnce();
	});
});
