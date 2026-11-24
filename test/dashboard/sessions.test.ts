import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { endSession, sessionFromToken, startSession } from '../../src/dashboard/sessions.ts';
import { SESSION_LIFETIME_MS } from '../../src/dashboard/storage.ts';
import { __resetForTests, db } from '../../src/core/database.ts';

beforeEach(() => {
	__resetForTests();
});

const user = { id: 'u1', username: 'alex' };

describe('dashboard sessions', () => {
	it('starts a session its token finds until it expires', () => {
		const { token, expiresAt } = startSession(user, 1000);

		expect(expiresAt).toBe(1000 + SESSION_LIFETIME_MS);
		expect(sessionFromToken(token, 2000)).toMatchObject({ user_id: 'u1', username: 'alex', created_at: 1000 });
		expect(sessionFromToken(token, expiresAt)).toBeUndefined();
	});

	it('gives each session its own unguessable token: 32 random bytes as base64url', () => {
		const first = startSession(user, 1000).token;
		const second = startSession(user, 1000).token;

		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(first, 'base64url')).toHaveLength(32);
		expect(second).not.toBe(first);
	});

	it('stores only the SHA-256 of the token, so the database alone signs no one in', () => {
		const { token } = startSession(user, 1000);

		const stored = db.prepare('SELECT * FROM dashboard_sessions').all() as Record<string, unknown>[];
		expect(stored).toHaveLength(1);
		expect(stored[0]!['id_hash']).toBe(createHash('sha256').update(token).digest('hex'));
		expect(JSON.stringify(stored)).not.toContain(token);
		expect(sessionFromToken(stored[0]!['id_hash'] as string, 2000)).toBeUndefined();
	});

	it.each([undefined, '', 'short', `${'a'.repeat(43)}=`, `${'a'.repeat(42)}!`])(
		'finds no session for a missing or malformed token (%j)',
		(token) => {
			startSession(user, 1000);

			expect(sessionFromToken(token, 2000)).toBeUndefined();
		},
	);

	it('finds no session for a well-formed token it never issued', () => {
		startSession(user, 1000);

		expect(sessionFromToken('a'.repeat(43), 2000)).toBeUndefined();
	});

	it('ends a session, leaving the user signed in elsewhere', () => {
		const here = startSession(user, 1000).token;
		const elsewhere = startSession(user, 1000).token;

		endSession(here);

		expect(sessionFromToken(here, 2000)).toBeUndefined();
		expect(sessionFromToken(elsewhere, 2000)).toBeDefined();
	});

	it('does nothing when ending a missing or malformed token', () => {
		const { token } = startSession(user, 1000);

		endSession(undefined);
		endSession('not a token');

		expect(sessionFromToken(token, 2000)).toBeDefined();
	});
});
