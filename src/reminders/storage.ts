import { db } from '../core/database.ts';

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
	embed: number;
}

export interface UserSettings {
	user_id: string;
	dm_enabled: number;
	interval_minutes: number;
	message: string;
	last_sent_at: number;
	snoozed_until: number;
	embed: number;
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
export function isGuildMasterEnabled(guildId: string): boolean {
	const settings = getGuildSettings(guildId);
	return settings ? settings.master_enabled === 1 : true;
}

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
	embed?: boolean;
}): void {
	db.prepare(
		`INSERT INTO guild_reminders (guild_id, reminder_label, channel_id, interval_minutes, message, embed)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		reminder.guildId,
		reminder.label,
		reminder.channelId,
		reminder.intervalMinutes,
		reminder.message,
		(reminder.embed ?? true) ? 1 : 0,
	);
}

// Writes all four columns back, merged with the current row, rather than
// building the SET clause from whichever options were given. Returns the
// updated row, or undefined if there is no such reminder.
export function updateGuildReminder(
	guildId: string,
	label: string,
	updates: {
		channelId?: string;
		intervalMinutes?: number;
		message?: string;
		embed?: boolean;
	},
): GuildReminder | undefined {
	const existing = getGuildReminderByLabel(guildId, label);
	if (!existing) return undefined;

	const channelId = updates.channelId ?? existing.channel_id;
	const intervalMinutes = updates.intervalMinutes ?? existing.interval_minutes;
	const message = updates.message ?? existing.message;
	const embed = updates.embed === undefined ? existing.embed : updates.embed ? 1 : 0;

	db.prepare(
		'UPDATE guild_reminders SET channel_id = ?, interval_minutes = ?, message = ?, embed = ? WHERE guild_id = ? AND reminder_label = ?',
	).run(channelId, intervalMinutes, message, embed, guildId, label);

	return { ...existing, channel_id: channelId, interval_minutes: intervalMinutes, message, embed };
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
	embed: boolean;
}): void {
	db.prepare(
		`INSERT INTO user_settings (user_id, dm_enabled, interval_minutes, message, embed)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   dm_enabled = excluded.dm_enabled,
		   interval_minutes = excluded.interval_minutes,
		   message = excluded.message,
		   embed = excluded.embed`,
	).run(
		settings.userId,
		settings.dmEnabled ? 1 : 0,
		settings.intervalMinutes,
		settings.message,
		settings.embed ? 1 : 0,
	);
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
