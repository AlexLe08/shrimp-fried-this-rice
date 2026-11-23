import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { snapshotBeforeMigration } from './backup.ts';

// From the project root, not this file's folder: a default that moved with
// this file would open a new, empty database without any error (the tests use
// DB_PATH, and *.db* is gitignored). One file for every area (decision 0004).
export function databasePath(): string {
	return process.env['DB_PATH'] ?? path.join(import.meta.dirname, '..', '..', 'bot.db');
}

const dbPath = databasePath();
// Checked before opening, which creates the file: a new database has nothing
// to save before its first migrations.
const existed = dbPath !== ':memory:' && dbPath !== '' && fs.existsSync(dbPath);

/** Where snapshots of the database go (src/core/backup.ts); null for an in-memory or temporary database. */
export function backupDirectory(): string | null {
	return dbPath === ':memory:' || dbPath === '' ? null : path.join(path.dirname(dbPath), 'backups');
}

export const db = new Database(dbPath);

// WAL: the scheduler reads while commands write.
db.pragma('journal_mode = WAL');

// The tables as first created. CREATE TABLE IF NOT EXISTS never alters an
// existing table, so these stay as they are and every later column comes from
// MIGRATIONS below; a new database and production's go through the same steps.
// Booleans are INTEGER 0/1; labels are unique per server.
db.exec(`
	CREATE TABLE IF NOT EXISTS guild_settings (
		guild_id TEXT PRIMARY KEY,
		master_enabled INTEGER NOT NULL DEFAULT 1
	);

	CREATE TABLE IF NOT EXISTS guild_reminders (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		guild_id TEXT NOT NULL,
		reminder_label TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		interval_minutes INTEGER NOT NULL,
		message TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		last_sent_at INTEGER NOT NULL DEFAULT 0,
		UNIQUE(guild_id, reminder_label)
	);
	CREATE TABLE IF NOT EXISTS user_settings (
		user_id TEXT PRIMARY KEY,
		dm_enabled INTEGER NOT NULL DEFAULT 0,
		interval_minutes INTEGER NOT NULL DEFAULT 60,
		message TEXT NOT NULL DEFAULT 'Time for a quick break!',
		last_sent_at INTEGER NOT NULL DEFAULT 0
	);
    CREATE TABLE IF NOT EXISTS guild_status_messages (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL
    );
`);

// Migration n (from 0) takes PRAGMA user_version from n to n + 1. Append
// only: production's database has already run the ones here
// (docs/decisions/0002-schema-migrations-with-user-version.md), except a
// pre-release reset that deletes that database (decision 0003). One list for
// every area, as user_version is a single number.
const MIGRATIONS = [
	// snoozed_until: epoch ms; a reminder isn't sent before it. 0 = not snoozed.
	`ALTER TABLE guild_reminders ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0;
	 ALTER TABLE user_settings ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0;`,
	// embed: 1 sends the reminder as an embed, 0 as plain text. Reminders made
	// before the choice existed were already sent as embeds, so they stay so.
	`ALTER TABLE guild_reminders ADD COLUMN embed INTEGER NOT NULL DEFAULT 1;
	 ALTER TABLE user_settings ADD COLUMN embed INTEGER NOT NULL DEFAULT 1;`,
	// /recruit (src/ffxiv/recruit/storage.ts). enabled = 0 pauses a server's
	// follow-ups after its channel went or Discord refused a post, until
	// /recruit config is run again. Names are of in-game characters, not
	// Discord accounts; name_key is the trimmed, lowercased name. status is
	// pending, reminded (posted, still open), promoted or left; times are epoch
	// ms. A name is open (pending or reminded) at most once per server, but can
	// be added again once resolved.
	`CREATE TABLE recruit_settings (
		guild_id TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL,
		ping_role_id TEXT,
		follow_up_days INTEGER NOT NULL DEFAULT 30,
		enabled INTEGER NOT NULL DEFAULT 1
	);
	CREATE TABLE recruits (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		guild_id TEXT NOT NULL,
		name TEXT NOT NULL,
		name_key TEXT NOT NULL,
		note TEXT NOT NULL DEFAULT '',
		added_by TEXT NOT NULL,
		added_at INTEGER NOT NULL,
		due_at INTEGER NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		resolved_by TEXT,
		resolved_at INTEGER
	);
	CREATE UNIQUE INDEX recruits_open_name ON recruits (guild_id, name_key) WHERE status IN ('pending', 'reminded');`,
];

const schemaVersion = db.pragma('user_version', { simple: true }) as number;
if (schemaVersion < MIGRATIONS.length) {
	// Throws when the snapshot can't be saved, so the bot exits unmigrated
	// (the deploy's login check reports it) rather than migrating without one.
	const backups = backupDirectory();
	if (existed && backups) snapshotBeforeMigration(db, backups, schemaVersion);
	// One transaction: a migration that fails partway leaves the database, and
	// its version, as they were.
	db.transaction(() => {
		for (const migration of MIGRATIONS.slice(schemaVersion)) {
			db.exec(migration);
		}
		db.pragma(`user_version = ${MIGRATIONS.length}`);
	})();
}

export function closeDatabase(): void {
	db.close();
}

// Test-only: clears every table between tests.
export function __resetForTests(): void {
	db.exec(`
	DELETE FROM guild_settings;
	DELETE FROM guild_reminders;
	DELETE FROM user_settings;
	DELETE FROM guild_status_messages;
	DELETE FROM recruit_settings;
	DELETE FROM recruits;
	`);
}
