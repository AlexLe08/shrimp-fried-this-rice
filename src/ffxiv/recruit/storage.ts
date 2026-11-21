import { db } from '../../core/database.ts';

// Row shapes, written by hand: query results are cast to these unchecked,
// so a column change updates its interface in the same commit.
export interface RecruitSettings {
	guild_id: string;
	channel_id: string;
	ping_role_id: string | null;
	follow_up_days: number;
	enabled: number;
}

export type RecruitStatus = 'pending' | 'reminded' | 'promoted' | 'left';
export type RecruitOutcome = Extract<RecruitStatus, 'promoted' | 'left'>;

export interface Recruit {
	id: number;
	guild_id: string;
	name: string;
	name_key: string;
	note: string;
	added_by: string;
	added_at: number;
	due_at: number;
	status: RecruitStatus;
	resolved_by: string | null;
	resolved_at: number | null;
}

/** A recruit whose follow-up is due, with where to post it. */
export interface DueRecruit extends Recruit {
	channel_id: string;
	ping_role_id: string | null;
}

export const MAX_RECRUIT_NAME_LENGTH = 50;
export const MAX_RECRUIT_NOTE_LENGTH = 300;
export const MAX_OPEN_RECRUITS_PER_GUILD = 100;
// The schema's default for follow_up_days too, used before /recruit config.
export const DEFAULT_FOLLOW_UP_DAYS = 30;
export const MIN_FOLLOW_UP_DAYS = 1;
export const MAX_FOLLOW_UP_DAYS = 365;

export const DAY_MS = 24 * 60 * 60 * 1000;

// Names are matched however they're capitalised or spaced at the ends, so
// "alex le" finds "Alex Le".
export function recruitNameKey(name: string): string {
	return name.trim().toLowerCase();
}

// --- Settings ---
export function getRecruitSettings(guildId: string): RecruitSettings | undefined {
	return db.prepare('SELECT * FROM recruit_settings WHERE guild_id = ?').get(guildId) as RecruitSettings | undefined;
}

/**
 * Saves the given settings, keeping the others, and resumes follow-ups if
 * they were paused. A server's first call must name a channel; without one
 * nothing is saved and the result is undefined. `pingRoleId: null` stops
 * pinging a role.
 */
export function setRecruitSettings(
	guildId: string,
	updates: { channelId?: string; pingRoleId?: string | null; followUpDays?: number },
): RecruitSettings | undefined {
	const existing = getRecruitSettings(guildId);
	const channelId = updates.channelId ?? existing?.channel_id;
	if (channelId === undefined) return undefined;
	const pingRoleId = updates.pingRoleId === undefined ? (existing?.ping_role_id ?? null) : updates.pingRoleId;
	const followUpDays = updates.followUpDays ?? existing?.follow_up_days ?? DEFAULT_FOLLOW_UP_DAYS;
	db.prepare(
		`INSERT INTO recruit_settings (guild_id, channel_id, ping_role_id, follow_up_days, enabled)
		 VALUES (?, ?, ?, ?, 1)
		 ON CONFLICT(guild_id) DO UPDATE SET
			channel_id = excluded.channel_id,
			ping_role_id = excluded.ping_role_id,
			follow_up_days = excluded.follow_up_days,
			enabled = 1`,
	).run(guildId, channelId, pingRoleId, followUpDays);
	return getRecruitSettings(guildId);
}

// Only while the channel is still the one that failed: /recruit config may
// have moved follow-ups elsewhere during the send.
export function pauseRecruitFollowUps(guildId: string, channelId: string): void {
	db.prepare('UPDATE recruit_settings SET enabled = 0 WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
}

// --- Recruits ---
const OPEN = `status IN ('pending', 'reminded')`;

export function getOpenRecruits(guildId: string): Recruit[] {
	return db
		.prepare(`SELECT * FROM recruits WHERE guild_id = ? AND ${OPEN} ORDER BY due_at, name_key`)
		.all(guildId) as Recruit[];
}

export function getOpenRecruitCount(guildId: string): number {
	const result = db.prepare(`SELECT COUNT(*) AS count FROM recruits WHERE guild_id = ? AND ${OPEN}`).get(guildId) as {
		count: number;
	};
	return result.count;
}

export function getOpenRecruitByName(guildId: string, name: string): Recruit | undefined {
	return db
		.prepare(`SELECT * FROM recruits WHERE guild_id = ? AND name_key = ? AND ${OPEN}`)
		.get(guildId, recruitNameKey(name)) as Recruit | undefined;
}

/** Throws if the name is already open in the server (the unique index). */
export function addRecruit(recruit: {
	guildId: string;
	name: string;
	note: string;
	addedBy: string;
	addedAt: number;
	dueAt: number;
}): Recruit {
	const name = recruit.name.trim();
	const { lastInsertRowid } = db
		.prepare(
			`INSERT INTO recruits (guild_id, name, name_key, note, added_by, added_at, due_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(recruit.guildId, name, recruitNameKey(name), recruit.note, recruit.addedBy, recruit.addedAt, recruit.dueAt);
	return getRecruitById(Number(lastInsertRowid))!;
}

function getRecruitById(id: number): Recruit | undefined {
	return db.prepare('SELECT * FROM recruits WHERE id = ?').get(id) as Recruit | undefined;
}

/**
 * Changes an open recruit's name, note or due date, keeping the others. A
 * different due date makes the follow-up pending again, so it's posted
 * (again) when it comes; the same one leaves a posted follow-up as it is. Returns the updated row, or undefined if the recruit isn't open.
 * Throws if the new name is already open in the server.
 */
export function updateRecruit(
	id: number,
	updates: { name?: string; note?: string; dueAt?: number },
): Recruit | undefined {
	const existing = getRecruitById(id);
	if (!existing || (existing.status !== 'pending' && existing.status !== 'reminded')) return undefined;
	const name = updates.name?.trim() ?? existing.name;
	const note = updates.note ?? existing.note;
	const dueAt = updates.dueAt ?? existing.due_at;
	const status = dueAt === existing.due_at ? existing.status : 'pending';
	db.prepare('UPDATE recruits SET name = ?, name_key = ?, note = ?, due_at = ?, status = ? WHERE id = ?').run(
		name,
		recruitNameKey(name),
		note,
		dueAt,
		status,
		id,
	);
	return getRecruitById(id);
}

/** Closes an open recruit. False if it wasn't open (already resolved or removed). */
export function resolveRecruit(id: number, outcome: RecruitOutcome, resolvedBy: string, now: number): boolean {
	return (
		db
			.prepare(`UPDATE recruits SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND ${OPEN}`)
			.run(outcome, resolvedBy, now, id).changes > 0
	);
}

export function deleteRecruit(id: number): void {
	db.prepare('DELETE FROM recruits WHERE id = ?').run(id);
}

// --- Follow-ups ---
// Servers without settings, or paused, have none due: their recruits stay
// pending and are posted once /recruit config is run.
export function getDueRecruits(now: number): DueRecruit[] {
	return db
		.prepare(
			`SELECT r.*, s.channel_id, s.ping_role_id
			 FROM recruits r
			 JOIN recruit_settings s ON s.guild_id = r.guild_id
			 WHERE r.status = 'pending' AND r.due_at <= ? AND s.enabled = 1
			 ORDER BY r.due_at, r.id`,
		)
		.all(now) as DueRecruit[];
}

// Only if nobody changed the due date during the send: /recruit snooze or
// edit then stands, rather than being marked as already posted.
export function markRecruitReminded(id: number, dueAt: number): void {
	db.prepare(`UPDATE recruits SET status = 'reminded' WHERE id = ? AND status = 'pending' AND due_at = ?`).run(
		id,
		dueAt,
	);
}
