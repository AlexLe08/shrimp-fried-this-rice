import { createHash, randomBytes } from 'node:crypto';
import { SESSION_LIFETIME_MS, createSession, deleteSession, getSession, type DashboardSession } from './storage.ts';

// 32 random bytes, as base64url: 43 characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** Starts a session for a user who has just logged in; the token goes in their cookie and nowhere else. */
export function startSession(
	user: { id: string; username: string },
	now: number,
): { token: string; expiresAt: number } {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = now + SESSION_LIFETIME_MS;
	createSession({
		id_hash: hashToken(token),
		user_id: user.id,
		username: user.username,
		created_at: now,
		expires_at: expiresAt,
	});
	return { token, expiresAt };
}

/** The live session a cookie's token belongs to, or undefined (no token, malformed, unknown or expired). */
export function sessionFromToken(token: string | undefined, now: number): DashboardSession | undefined {
	if (!token || !TOKEN_PATTERN.test(token)) return undefined;
	return getSession(hashToken(token), now);
}

/** Ends the session a token belongs to, if any, so its cookie no longer signs anyone in. */
export function endSession(token: string | undefined): void {
	if (!token || !TOKEN_PATTERN.test(token)) return;
	deleteSession(hashToken(token));
}
