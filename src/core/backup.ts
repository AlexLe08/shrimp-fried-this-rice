import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { ScheduledCheck } from './scheduler.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
// A failed daily snapshot (a full disk, say) is tried again after this,
// rather than on every 60 s poll, which would fill the journal with errors.
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

/** How many of each kind are kept; older ones are deleted after a new one is saved. */
export const KEEP_DAILY = 7;
export const KEEP_PRE_MIGRATION = 5;

// File names carry the time (ISO 8601, `:` replaced so the name is valid
// everywhere), so they sort by age, and the daily check knows when the last
// one was taken across restarts without keeping any state of its own.
const DAILY = /^daily-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)\.db$/;
const PRE_MIGRATION = /^pre-migration-v\d+-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)\.db$/;

function stampOf(date: Date): string {
	return date.toISOString().replaceAll(':', '-');
}

function dateOf(stamp: string): Date {
	return new Date(stamp.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3'));
}

/**
 * Writes a consistent copy of the database to `dir/<prefix>-<time>.db` and
 * returns its path. Synchronous: database.ts snapshots before migrating, at
 * import, before anything else can run.
 */
export function saveSnapshot(db: Database.Database, dir: string, prefix: string, now: Date): string {
	// 0700: the database will hold webhook tokens and keys. Only applies when
	// the folder is created.
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${prefix}-${stampOf(now)}.db`);
	// VACUUM INTO refuses a file that exists, and one cut off by a crash or
	// power loss can be corrupt, so it writes beside the name and is renamed
	// into place only once complete.
	const partial = `${file}.tmp`;
	fs.rmSync(partial, { force: true });
	try {
		db.prepare('VACUUM INTO ?').run(partial);
		fs.renameSync(partial, file);
	} catch (error) {
		fs.rmSync(partial, { force: true });
		throw error;
	}
	return file;
}

// Oldest first.
function snapshotsIn(dir: string, pattern: RegExp): { file: string; takenAt: Date }[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.flatMap((name) => {
			const match = pattern.exec(name);
			return match ? [{ file: path.join(dir, name), takenAt: dateOf(match[1]!) }] : [];
		})
		.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
}

function prune(dir: string, pattern: RegExp, keep: number): void {
	const snapshots = snapshotsIn(dir, pattern);
	for (const { file } of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
		fs.rmSync(file, { force: true });
	}
}

/**
 * Saves the database as it is before migrating from `fromVersion`, so a
 * migration that commits but turns out wrong (drops or rewrites rows) can be
 * undone by hand. The migration's own transaction only covers one that fails.
 */
export function snapshotBeforeMigration(db: Database.Database, dir: string, fromVersion: number): string {
	const file = saveSnapshot(db, dir, `pre-migration-v${fromVersion}`, new Date());
	prune(dir, PRE_MIGRATION, KEEP_PRE_MIGRATION);
	return file;
}

/** The scheduled check that saves a snapshot once the newest daily one is a day old. */
export function dailyBackupCheck(db: Database.Database, dir: string): ScheduledCheck {
	let lastFailureAt = -Infinity;
	return {
		name: 'Daily backup',
		async run() {
			const now = Date.now();
			if (now - lastFailureAt < RETRY_AFTER_FAILURE_MS) return;
			try {
				const newest = snapshotsIn(dir, DAILY).at(-1);
				if (newest && now - newest.takenAt.getTime() < DAY_MS) return;
				const file = saveSnapshot(db, dir, 'daily', new Date(now));
				prune(dir, DAILY, KEEP_DAILY);
				console.log(`Saved a daily backup: ${file}`);
			} catch (error) {
				lastFailureAt = now;
				throw error;
			}
		},
	};
}
