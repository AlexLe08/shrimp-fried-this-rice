import { db } from '../core/database.ts';

// Row shape, written by hand: query results are cast to it unchecked, so a
// column change updates it in the same commit.
export interface DashboardSession {
	id_hash: string;
	user_id: string;
	username: string;
	created_at: number;
	expires_at: number;
}

// Counted from login, not from the last visit, so a stolen cookie is good for
// at most this long.
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
// Logging in again doesn't end earlier sessions (another browser may hold
// one), so this bounds how many rows one user's repeated logins can add.
export const MAX_SESSIONS_PER_USER = 10;

/**
 * Saves a new session. In the same transaction, deletes every expired
 * session and the user's oldest beyond MAX_SESSIONS_PER_USER, so the table
 * holds a bounded number per user. Expired rows stay until someone logs in;
 * getSession ignores them, so they sign no one in.
 */
export const createSession = db.transaction((session: DashboardSession): void => {
	db.prepare('DELETE FROM dashboard_sessions WHERE expires_at <= ?').run(session.created_at);
	db.prepare(
		`DELETE FROM dashboard_sessions WHERE user_id = ? AND id_hash NOT IN (
			SELECT id_hash FROM dashboard_sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
		)`,
	).run(session.user_id, session.user_id, MAX_SESSIONS_PER_USER - 1);
	db.prepare(
		`INSERT INTO dashboard_sessions (id_hash, user_id, username, created_at, expires_at)
		VALUES (@id_hash, @user_id, @username, @created_at, @expires_at)`,
	).run(session);
});

/** The session with this hash, unless it has expired by `now`. */
export function getSession(idHash: string, now: number): DashboardSession | undefined {
	return db.prepare('SELECT * FROM dashboard_sessions WHERE id_hash = ? AND expires_at > ?').get(idHash, now) as
		DashboardSession | undefined;
}

export function deleteSession(idHash: string): void {
	db.prepare('DELETE FROM dashboard_sessions WHERE id_hash = ?').run(idHash);
}
