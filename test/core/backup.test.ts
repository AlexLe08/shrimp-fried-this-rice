import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	saveSnapshot,
	snapshotBeforeMigration,
	dailyBackupCheck,
	KEEP_DAILY,
	KEEP_PRE_MIGRATION,
} from '../../src/core/backup.ts';
import { startScheduler, stopScheduler } from '../../src/core/scheduler.ts';

const POLL_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let dir: string;
let backups: string;
let db: Database.Database;

function rowsIn(file: string): { label: string }[] {
	const copy = new Database(file, { readonly: true });
	const rows = copy.prepare('SELECT label FROM things ORDER BY label').all() as { label: string }[];
	copy.close();
	return rows;
}

function listBackups(): string[] {
	return fs.existsSync(backups) ? fs.readdirSync(backups).sort() : [];
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
	backups = path.join(dir, 'backups');
	db = new Database(path.join(dir, 'bot.db'));
	db.pragma('journal_mode = WAL');
	db.exec(`CREATE TABLE things (label TEXT); INSERT INTO things VALUES ('a'), ('b');`);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
	await stopScheduler();
	vi.useRealTimers();
	vi.restoreAllMocks();
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('saveSnapshot', () => {
	it('writes a copy of the database, named by its time, in a folder only the owner can open', () => {
		const file = saveSnapshot(db, backups, 'daily', new Date('2026-11-23T19:30:05.123Z'));

		expect(path.basename(file)).toBe('daily-2026-11-23T19-30-05.123Z.db');
		expect(rowsIn(file)).toEqual([{ label: 'a' }, { label: 'b' }]);
		expect(listBackups()).toEqual(['daily-2026-11-23T19-30-05.123Z.db']);
		if (process.platform !== 'win32') expect(fs.statSync(backups).mode & 0o777).toBe(0o700);
	});

	it('includes writes still only in the WAL file', () => {
		db.exec(`INSERT INTO things VALUES ('c')`);

		const file = saveSnapshot(db, backups, 'daily', new Date());

		expect(rowsIn(file).map((row) => row.label)).toEqual(['a', 'b', 'c']);
	});

	it('removes a partial copy left by a process killed mid-copy', () => {
		fs.mkdirSync(backups);
		fs.writeFileSync(path.join(backups, 'daily-2026-01-01T00-00-00.000Z.db.tmp'), 'cut off');

		const file = saveSnapshot(db, backups, 'daily', new Date('2026-11-23T00:00:00.000Z'));

		expect(listBackups()).toEqual([path.basename(file)]);
	});

	it('leaves no file behind when the copy fails', () => {
		// SQLite refuses VACUUM inside a transaction.
		db.exec('BEGIN');

		expect(() => saveSnapshot(db, backups, 'daily', new Date())).toThrow(/transaction/);

		db.exec('ROLLBACK');
		expect(listBackups()).toEqual([]);
	});
});

describe('snapshotBeforeMigration', () => {
	it('names the version it was taken at and keeps only the newest few', () => {
		vi.useFakeTimers({ now: new Date('2026-11-01T00:00:00.000Z'), toFake: ['Date'] });
		const files: string[] = [];
		for (let i = 0; i < KEEP_PRE_MIGRATION + 2; i++) {
			files.push(path.basename(snapshotBeforeMigration(db, backups, i)!));
			vi.advanceTimersByTime(1000);
		}

		expect(files[0]).toBe('pre-migration-v0-2026-11-01T00-00-00.000Z.db');
		expect(listBackups()).toEqual(files.slice(2).sort());
	});

	it('reuses one at the same version from the last 10 minutes, as in a crash loop', () => {
		vi.useFakeTimers({ now: new Date('2026-11-01T00:00:00.000Z'), toFake: ['Date'] });
		const first = snapshotBeforeMigration(db, backups, 3);

		vi.advanceTimersByTime(5000);
		expect(snapshotBeforeMigration(db, backups, 3)).toBeNull();
		// A reset back to v0 isn't the same snapshot.
		expect(snapshotBeforeMigration(db, backups, 0)).not.toBeNull();

		vi.advanceTimersByTime(10 * 60 * 1000);
		const later = snapshotBeforeMigration(db, backups, 3);
		expect(listBackups().filter((name) => name.startsWith('pre-migration-v3-'))).toEqual(
			[first!, later!].map((file) => path.basename(file)),
		);
	});

	it("doesn't prune daily snapshots", () => {
		saveSnapshot(db, backups, 'daily', new Date('2026-01-01T00:00:00.000Z'));
		for (let i = 0; i < KEEP_PRE_MIGRATION + 1; i++) {
			saveSnapshot(db, backups, `pre-migration-v${i}`, new Date(Date.UTC(2026, 1, 1 + i)));
		}
		snapshotBeforeMigration(db, backups, 9);

		expect(listBackups()).toContain('daily-2026-01-01T00-00-00.000Z.db');
	});
});

describe('dailyBackupCheck', () => {
	function dailies(): string[] {
		return listBackups().filter((name) => name.startsWith('daily-'));
	}

	beforeEach(() => {
		vi.useFakeTimers({ now: new Date('2026-11-23T12:00:00.000Z') });
	});

	it('saves one on the first poll, then not again until a day later', async () => {
		startScheduler([dailyBackupCheck(db, backups)]);

		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(dailies()).toEqual(['daily-2026-11-23T12-01-00.000Z.db']);

		await vi.advanceTimersByTimeAsync(DAY_MS - POLL_MS);
		expect(dailies()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(dailies()).toEqual(['daily-2026-11-23T12-01-00.000Z.db', 'daily-2026-11-24T12-01-00.000Z.db']);
	});

	it('counts the day from a snapshot saved before a restart', async () => {
		saveSnapshot(db, backups, 'daily', new Date('2026-11-23T06:00:00.000Z'));
		startScheduler([dailyBackupCheck(db, backups)]);

		await vi.advanceTimersByTimeAsync(17 * HOUR_MS);
		expect(dailies()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(HOUR_MS);
		expect(dailies()).toHaveLength(2);
	});

	it('takes one when the newest is stamped in the future, after the clock was set back', async () => {
		saveSnapshot(db, backups, 'daily', new Date('2026-11-25T00:00:00.000Z'));
		startScheduler([dailyBackupCheck(db, backups)]);

		await vi.advanceTimersByTimeAsync(POLL_MS);

		expect(dailies()).toContain('daily-2026-11-23T12-01-00.000Z.db');
	});

	it(`keeps the newest ${KEEP_DAILY}`, async () => {
		startScheduler([dailyBackupCheck(db, backups)]);

		await vi.advanceTimersByTimeAsync(POLL_MS + (KEEP_DAILY + 2) * DAY_MS);

		const kept = dailies();
		expect(kept).toHaveLength(KEEP_DAILY);
		expect(kept.at(-1)).toBe('daily-2026-12-02T12-01-00.000Z.db');
	});

	it('logs a failure and tries again an hour later, not every poll', async () => {
		// A file where the folder should be: every attempt fails.
		fs.writeFileSync(backups, '');
		const check = dailyBackupCheck(db, backups);
		const run = vi.spyOn(check, 'run');
		startScheduler([check]);

		await vi.advanceTimersByTimeAsync(HOUR_MS);
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledWith('Daily backup check failed:', expect.any(Error));

		fs.rmSync(backups);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(dailies()).toHaveLength(1);
		expect(run).toHaveBeenCalledTimes(61);
	});
});
