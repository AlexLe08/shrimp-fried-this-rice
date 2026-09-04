import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create new db or open existing one
const dbPath = path.join(__dirname, '..', 'reminders.db');
const db = new Database(dbPath);

// SQLite's write-ahead-logging mode, the standard for any app doing concurrent reads and writes (bot will be reading the scheduler loop while commands are writing settings). Without it, SQLite still works, just with more conservative locking.
db.pragma('journal_mode = WAL');

// Make tables if they don't exist already,
// use guild_id as primary key because unique identifier already; a 'one row per server' schema
// master_enabled - integer 0/1 because no real bool type with SQL; it uses 0/1 instead
// UNIQUE(guild_id, reminder_label) compound constraint: the combination of two columns must be unique, even though neither column alone is. So guild_id=111, reminder_label="water" and guild_id=222, reminder_label="water" are both fine (different servers, same label) — but two "water" labels in the same server would be rejected by SQLite. 
// CAUTION: be mindful when adding new columns to table as well as renaming columns, update interfaces to reflect any column changes within the same commit; TypeScript cannot flag any mistakes between TypeScript and schema mismatches

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
`);

// prop names match SQLite's snake_case naming conventions for its columns
// TypeScript has no way to look in a string of SQL text and know what columns the query will return. Any SQL operation could return any shape object
// Use type assertion when calling .get(), .all(); using as GuildSettings | undefined, etc; 
// TypeScript does not verify this assertion against anything real; trust me bro moment
// CAUTION: be mindful when adding new columns to table as well as renaming columns, update interfaces to reflect any column changes within the same commit; TypeScript cannot flag any mistakes between TypeScript and schema mismatches
export interface GuildSettings {
	guild_id: string;
	master_enabled: number;
}

export interface GuildReminder {
	id: number;
	guild_id: string;
	reminder_label: string;
	channel_id: string;
	interval_minutes: number;
	message: string;
	enabled: number;
	last_sent_at: number;
}

export interface UserSettings {
	user_id: string;
	dm_enabled: number;
	interval_minutes: number;
	message: string;
	last_sent_at: number;
}

// Minimum 5 minutes, maximum 24 hours
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;

// --- Guild master toggle ---
//.get() is specifically returning 0 or 1 result; for looking up a single server by its unique ID
// typewise, .get() and .all() return unknown and unknown[] due to better-sqlite3 sending raw SQL string to actual SLQite engine written in C.
export function getGuildSettings(guildId: string): GuildSettings | undefined {
	return db
		.prepare('SELECT * FROM guild_settings WHERE guild_id = ?')
		.get(guildId) as GuildSettings | undefined;
}

// Upsert: insert new row but if guildID CONFLICTs (same), update it instead; creates the row on first use, updates it on every call after.
// .excluded.master_enabled iis the valeu that would have been inserted; the ?
export function setGuildMasterEnabled(guildId: string, enabled: boolean): void {
	db.prepare(
		`INSERT INTO guild_settings (guild_id, master_enabled)
		 VALUES (?, ?)
		 ON CONFLICT(guild_id) DO UPDATE SET master_enabled = excluded.master_enabled`,
	).run(guildId, enabled ? 1 : 0);
}

// --- Guild reminders (multiple per guild) ---
// .all() returns more than 1 row; servers can have multiple reminders 
export function getGuildReminders(guildId: string): GuildReminder[] {
	return db
		.prepare('SELECT * FROM guild_reminders WHERE guild_id = ?')
		.all(guildId) as GuildReminder[];
}
// Grabs a specific reminder in a guild based on label
export function getGuildReminderByLabel(guildId: string, label: string): GuildReminder | undefined {
	return db
		.prepare('SELECT * FROM guild_reminders WHERE guild_id = ? AND reminder_label = ?')
		.get(guildId, label) as GuildReminder | undefined;
}

// Adds new row. The ? placeholders line up with columns. 
// .run() used for insert/update/delete opertions, returns nothing
export function createGuildReminder(reminder: {
	guildId: string;
	label: string;
	channelId: string;
	intervalMinutes: number;
	message: string;
}): void {
	db.prepare(
		`INSERT INTO guild_reminders (guild_id, reminder_label, channel_id, interval_minutes, message)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(reminder.guildId, reminder.label, reminder.channelId, reminder.intervalMinutes, reminder.message);
}

// Why fetch-then-update-all-columns, instead of only updating the changed column(s): building SQL where the set of columns changes dynamically based on which options were provided is genuinely fiddly to do safely (you'd be conditionally concatenating column names into the query string). Reading the current row first and writing all three columns back — two unchanged, one new — sidesteps that complexity entirely, at the cost of a trivial extra SELECT. For a table this small, that's a good trade.
export function updateGuildReminder(guildId: string, label: string, updates: {
	channelId?: string;
	intervalMinutes?: number;
	message?: string;
}): void {
	const existing = getGuildReminderByLabel(guildId, label);
	if (!existing) return;

	const channelId = updates.channelId ?? existing.channel_id;
	const intervalMinutes = updates.intervalMinutes ?? existing.interval_minutes;
	const message = updates.message ?? existing.message;

	db.prepare(
		'UPDATE guild_reminders SET channel_id = ?, interval_minutes = ?, message = ? WHERE guild_id = ? AND reminder_label = ?',
	).run(channelId, intervalMinutes, message, guildId, label);
}

// Updates an existing reminder to be enabled; narrowed down by guildID and label
export function setGuildReminderEnabled(guildId: string, label: string, enabled: boolean): void {
	db.prepare(
		'UPDATE guild_reminders SET enabled = ? WHERE guild_id = ? AND reminder_label = ?',
	).run(enabled ? 1 : 0, guildId, label);
}

export function deleteGuildReminder(guildId: string, label: string): void {
	db.prepare(
		'DELETE FROM guild_reminders WHERE guild_id = ? AND reminder_label = ?',
	).run(guildId, label);
}

export function updateGuildReminderLastSent(reminderId: number, timestamp: number): void {
	db.prepare('UPDATE guild_reminders SET last_sent_at = ? WHERE id = ?').run(timestamp, reminderId);
}

// Reminders that are individually enabled and are due to fire.
// for every reminder row, find the matching guild_settings row where the guild_id values are equal, and treat them as one combined row for this query.
// Guild's master toggle must be enabled in addition to the individual reminder's toggle
// The last time this reminder was sent, plus its interval set by users, is less than or equal to right now, so its due to fire at this point
// interval_minutes * 60000 converts minutes to milliseconds (last_sent_at is a millisec timestamp); math happens in SQL rather than JavaScript
export function getDueGuildReminders(now: number): GuildReminder[] {
	return db
		.prepare(
			`SELECT gr.* FROM guild_reminders gr
			 JOIN guild_settings gs ON gs.guild_id = gr.guild_id
			 WHERE gr.enabled = 1
			   AND gs.master_enabled = 1
			   AND (gr.last_sent_at + gr.interval_minutes * 60000) <= ?`,
		)
		.all(now) as GuildReminder[];
}

// --- Per-user DM settings ---

export function getUserSettings(userId: string): UserSettings | undefined {
	return db
		.prepare('SELECT * FROM user_settings WHERE user_id = ?')
		.get(userId) as UserSettings | undefined;
}

export function upsertUserSettings(settings: {
	userId: string;
	dmEnabled: boolean;
	intervalMinutes: number;
	message: string;
}): void {
	db.prepare(
		`INSERT INTO user_settings (user_id, dm_enabled, interval_minutes, message)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   dm_enabled = excluded.dm_enabled,
		   interval_minutes = excluded.interval_minutes,
		   message = excluded.message`,
	).run(settings.userId, settings.dmEnabled ? 1 : 0, settings.intervalMinutes, settings.message);
}

export function updateUserLastSent(userId: string, timestamp: number): void {
	db.prepare('UPDATE user_settings SET last_sent_at = ? WHERE user_id = ?').run(timestamp, userId);
}

/** Users who are DM-opted-in and due to receive a reminder. */
export function getDueUserSettings(now: number): UserSettings[] {
	return db
		.prepare(
			`SELECT * FROM user_settings
			 WHERE dm_enabled = 1
			   AND (last_sent_at + interval_minutes * 60000) <= ?`,
		)
		.all(now) as UserSettings[];
}

export function deleteUserSettings(userId: string): void {
	db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
}