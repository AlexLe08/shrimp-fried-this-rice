import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Its own file: each case opens storage.ts on a database file of its own,
// built the way production's was before migrations existed.
let dir: string;
let dbPath: string;

function createPreMigrationDatabase(): void {
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, master_enabled INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE guild_reminders (
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
		CREATE TABLE user_settings (
			user_id TEXT PRIMARY KEY,
			dm_enabled INTEGER NOT NULL DEFAULT 0,
			interval_minutes INTEGER NOT NULL DEFAULT 60,
			message TEXT NOT NULL DEFAULT 'Time for a quick break!',
			last_sent_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE guild_status_messages (guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT NOT NULL);
		INSERT INTO guild_reminders (guild_id, reminder_label, channel_id, interval_minutes, message, last_sent_at)
			VALUES ('g1', 'water', 'c1', 30, 'drink', 12345);
		INSERT INTO user_settings (user_id, dm_enabled, interval_minutes, message, last_sent_at)
			VALUES ('u1', 1, 45, 'stretch', 67890);
	`);
	db.close();
}

async function openStorage() {
	vi.resetModules();
	vi.stubEnv('DB_PATH', dbPath);
	return import('../../src/storage.ts');
}

function inspect(): { version: number; reminderColumns: string[]; userColumns: string[] } {
	const db = new Database(dbPath, { readonly: true });
	const result = {
		version: db.pragma('user_version', { simple: true }) as number,
		reminderColumns: (db.pragma('table_info(guild_reminders)') as { name: string }[]).map((c) => c.name),
		userColumns: (db.pragma('table_info(user_settings)') as { name: string }[]).map((c) => c.name),
	};
	db.close();
	return result;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reminders-migrations-'));
	dbPath = path.join(dir, 'reminders.db');
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('schema migrations', () => {
	it('adds snoozed_until and embed to a pre-migration database and keeps its rows', async () => {
		createPreMigrationDatabase();

		const storage = await openStorage();
		const reminder = storage.getGuildReminderByLabel('g1', 'water');
		const user = storage.getUserSettings('u1');
		storage.closeDatabase();

		expect(reminder).toMatchObject({
			interval_minutes: 30,
			message: 'drink',
			last_sent_at: 12345,
			snoozed_until: 0,
			embed: 1,
		});
		expect(user).toMatchObject({
			interval_minutes: 45,
			message: 'stretch',
			last_sent_at: 67890,
			snoozed_until: 0,
			embed: 1,
		});
		// One per migration: 0 added snoozed_until, 1 added embed.
		expect(inspect()).toMatchObject({ version: 2 });
	});

	it('gives a new database the same schema', async () => {
		const storage = await openStorage();
		storage.closeDatabase();

		const { version, reminderColumns, userColumns } = inspect();
		expect(version).toBe(2);
		expect(reminderColumns).toEqual(expect.arrayContaining(['snoozed_until', 'embed']));
		expect(userColumns).toEqual(expect.arrayContaining(['snoozed_until', 'embed']));
	});

	it('rolls back the whole migration, and its version, when part of it fails', async () => {
		createPreMigrationDatabase();
		// The first ALTER (guild_reminders) succeeds; the second fails on the
		// column that's already there.
		const db = new Database(dbPath);
		db.exec('ALTER TABLE user_settings ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0');
		db.close();

		await expect(openStorage()).rejects.toThrow(/duplicate column/);

		const { version, reminderColumns } = inspect();
		expect(version).toBe(0);
		expect(reminderColumns).not.toContain('snoozed_until');
		expect(reminderColumns).not.toContain('embed');
	});

	it('does nothing on a database that is already up to date', async () => {
		createPreMigrationDatabase();
		(await openStorage()).closeDatabase();

		const storage = await openStorage();
		expect(storage.getGuildReminderByLabel('g1', 'water')?.snoozed_until).toBe(0);
		storage.closeDatabase();
		expect(inspect().version).toBe(2);
	});

	// Production's database ran migration 0 when snoozing shipped (#20).
	it('takes a database at version 1 to 2, sending its reminders as embeds', async () => {
		createPreMigrationDatabase();
		const db = new Database(dbPath);
		db.exec(`
			ALTER TABLE guild_reminders ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE user_settings ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0;
			UPDATE guild_reminders SET snoozed_until = 999;
		`);
		db.pragma('user_version = 1');
		db.close();

		const storage = await openStorage();
		const reminder = storage.getGuildReminderByLabel('g1', 'water');
		const user = storage.getUserSettings('u1');
		storage.closeDatabase();

		expect(reminder).toMatchObject({ message: 'drink', last_sent_at: 12345, snoozed_until: 999, embed: 1 });
		expect(user).toMatchObject({ message: 'stretch', embed: 1 });
		expect(inspect().version).toBe(2);
	});
});
