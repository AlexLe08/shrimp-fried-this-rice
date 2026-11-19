import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env['DB_PATH'] ?? path.join(__dirname, '..', 'reminders.db');
const db = new Database(dbPath);

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
// (docs/decisions/0002-schema-migrations-with-user-version.md).
const MIGRATIONS = [
	// snoozed_until: epoch ms; a reminder isn't sent before it. 0 = not snoozed.
	`ALTER TABLE guild_reminders ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0;
	 ALTER TABLE user_settings ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0;`,
];

const schemaVersion = db.pragma('user_version', { simple: true }) as number;
if (schemaVersion < MIGRATIONS.length) {
	// One transaction: a migration that fails partway leaves the database, and
	// its version, as they were.
	db.transaction(() => {
		for (const migration of MIGRATIONS.slice(schemaVersion)) {
			db.exec(migration);
		}
		db.pragma(`user_version = ${MIGRATIONS.length}`);
	})();
}

// Row shapes, written by hand: query results are cast to these unchecked,
// so a column change updates its interface in the same commit.
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
	snoozed_until: number;
}

export interface UserSettings {
	user_id: string;
	dm_enabled: number;
	interval_minutes: number;
	message: string;
	last_sent_at: number;
	snoozed_until: number;
}

export interface GuildStatusMessage {
	guild_id: string;
	channel_id: string;
	message_id: string;
}

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;

export const MAX_REMINDERS_PER_GUILD = 20;

export function getGuildReminderCount(guildId: string): number {
	const result = db.prepare('SELECT COUNT(*) as count FROM guild_reminders WHERE guild_id = ?').get(guildId) as {
		count: number;
	};
	return result.count;
}

// --- Guild master toggle ---
export function getGuildSettings(guildId: string): GuildSettings | undefined {
	return db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as GuildSettings | undefined;
}

// No row means enabled (the column's default): the row exists only once
// /reminder master has been used.
export function setGuildMasterEnabled(guildId: string, enabled: boolean): void {
	db.prepare(
		`INSERT INTO guild_settings (guild_id, master_enabled)
		 VALUES (?, ?)
		 ON CONFLICT(guild_id) DO UPDATE SET master_enabled = excluded.master_enabled`,
	).run(guildId, enabled ? 1 : 0);
}

// --- Guild reminders (multiple per guild) ---
export function getGuildReminders(guildId: string): GuildReminder[] {
	return db.prepare('SELECT * FROM guild_reminders WHERE guild_id = ?').all(guildId) as GuildReminder[];
}
export function getGuildReminderByLabel(guildId: string, label: string): GuildReminder | undefined {
	return db.prepare('SELECT * FROM guild_reminders WHERE guild_id = ? AND reminder_label = ?').get(guildId, label) as
		GuildReminder | undefined;
}

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

// Writes all three columns back, merged with the current row, rather than
// building the SET clause from whichever options were given.
export function updateGuildReminder(
	guildId: string,
	label: string,
	updates: {
		channelId?: string;
		intervalMinutes?: number;
		message?: string;
	},
): void {
	const existing = getGuildReminderByLabel(guildId, label);
	if (!existing) return;

	const channelId = updates.channelId ?? existing.channel_id;
	const intervalMinutes = updates.intervalMinutes ?? existing.interval_minutes;
	const message = updates.message ?? existing.message;

	db.prepare(
		'UPDATE guild_reminders SET channel_id = ?, interval_minutes = ?, message = ? WHERE guild_id = ? AND reminder_label = ?',
	).run(channelId, intervalMinutes, message, guildId, label);
}

export function setGuildReminderEnabled(guildId: string, label: string, enabled: boolean): void {
	db.prepare('UPDATE guild_reminders SET enabled = ? WHERE guild_id = ? AND reminder_label = ?').run(
		enabled ? 1 : 0,
		guildId,
		label,
	);
}

export function deleteGuildReminder(guildId: string, label: string): void {
	db.prepare('DELETE FROM guild_reminders WHERE guild_id = ? AND reminder_label = ?').run(guildId, label);
}

export function updateGuildReminderLastSent(reminderId: number, timestamp: number): void {
	db.prepare('UPDATE guild_reminders SET last_sent_at = ? WHERE id = ?').run(timestamp, reminderId);
}

// The scheduler's outcomes for a send that failed. Both match on the channel
// the scheduler tried: if the reminder was edited to another channel (or
// deleted and re-created) while that send was failing, the edit wins.
export function disableGuildReminderForChannel(reminderId: number, channelId: string): void {
	db.prepare('UPDATE guild_reminders SET enabled = 0 WHERE id = ? AND channel_id = ?').run(reminderId, channelId);
}

export function updateGuildReminderLastSentForChannel(reminderId: number, channelId: string, timestamp: number): void {
	db.prepare('UPDATE guild_reminders SET last_sent_at = ? WHERE id = ? AND channel_id = ?').run(
		timestamp,
		reminderId,
		channelId,
	);
}

// --- Snoozing ---
// A snooze holds a reminder back until `until`. With skipMissed, last_sent_at
// moves to `until`, so the next send is a full interval after the snooze ends;
// without it, a send missed during the snooze goes out at the first poll after.
// last_sent_at is clamped to `now` first, so re-snoozing (or cancelling) after
// a skipMissed snooze doesn't keep that snooze's future last_sent_at; cancelling
// is then the same as the snooze ending now.
// Accepted race: a snooze set while that reminder's send is in flight has
// its skipMissed last_sent_at overwritten when the scheduler records the
// send; snoozed_until still holds, so at worst it sends when the snooze
// ends instead of an interval later.
const SNOOZE_SET = `snoozed_until = @until,
	last_sent_at = CASE WHEN @skipMissed = 1 THEN @until ELSE MIN(last_sent_at, @now) END`;

export function snoozeGuildReminder(
	guildId: string,
	label: string,
	snooze: { until: number; skipMissed: boolean; now: number },
): void {
	db.prepare(`UPDATE guild_reminders SET ${SNOOZE_SET} WHERE guild_id = @guildId AND reminder_label = @label`).run({
		guildId,
		label,
		until: snooze.until,
		skipMissed: snooze.skipMissed ? 1 : 0,
		now: snooze.now,
	});
}

export function unsnoozeGuildReminder(guildId: string, label: string, now: number): void {
	db.prepare(
		`UPDATE guild_reminders SET snoozed_until = 0, last_sent_at = MIN(last_sent_at, ?)
		 WHERE guild_id = ? AND reminder_label = ?`,
	).run(now, guildId, label);
}

export function snoozeUser(userId: string, snooze: { until: number; skipMissed: boolean; now: number }): void {
	db.prepare(`UPDATE user_settings SET ${SNOOZE_SET} WHERE user_id = @userId`).run({
		userId,
		until: snooze.until,
		skipMissed: snooze.skipMissed ? 1 : 0,
		now: snooze.now,
	});
}

export function unsnoozeUser(userId: string, now: number): void {
	db.prepare('UPDATE user_settings SET snoozed_until = 0, last_sent_at = MIN(last_sent_at, ?) WHERE user_id = ?').run(
		now,
		userId,
	);
}

// Enabled, unsnoozed reminders whose interval has passed, in servers whose
// master toggle is on. LEFT JOIN, not JOIN: a server that never used /reminder
// master has no guild_settings row, and an inner join silently never fired its
// reminders.
export function getDueGuildReminders(now: number): GuildReminder[] {
	return db
		.prepare(
			`SELECT gr.* FROM guild_reminders gr
			 LEFT JOIN guild_settings gs ON gs.guild_id = gr.guild_id
			 WHERE gr.enabled = 1
			   AND (gs.master_enabled IS NULL OR gs.master_enabled = 1)
			   AND gr.snoozed_until <= @now
			   AND (gr.last_sent_at + gr.interval_minutes * 60000) <= @now`,
		)
		.all({ now }) as GuildReminder[];
}

export function setGuildStatusMessage(guildId: string, channelId: string, messageId: string): void {
	db.prepare(
		`INSERT INTO guild_status_messages (guild_id, channel_id, message_id)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           channel_id = excluded.channel_id,
           message_id = excluded.message_id`,
	).run(guildId, channelId, messageId);
}

export function getGuildStatusMessage(guildId: string): GuildStatusMessage | undefined {
	return db.prepare('SELECT * FROM guild_status_messages WHERE guild_id = ?').get(guildId) as
		GuildStatusMessage | undefined;
}

export function deleteGuildStatusMessage(guildId: string): void {
	db.prepare('DELETE FROM guild_status_messages WHERE guild_id = ?').run(guildId);
}

// --- Per-user DM settings ---

export function getUserSettings(userId: string): UserSettings | undefined {
	return db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
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

/** Users who are DM-opted-in, not snoozed, and due to receive a reminder. */
export function getDueUserSettings(now: number): UserSettings[] {
	return db
		.prepare(
			`SELECT * FROM user_settings
			 WHERE dm_enabled = 1
			   AND snoozed_until <= @now
			   AND (last_sent_at + interval_minutes * 60000) <= @now`,
		)
		.all({ now }) as UserSettings[];
}

export function deleteUserSettings(userId: string): void {
	db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
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
	`);
}
