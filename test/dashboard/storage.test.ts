import { describe, it, expect, beforeEach } from 'vitest';
import {
	MAX_SESSIONS_PER_USER,
	createSession,
	deleteSession,
	getSession,
	type DashboardSession,
} from '../../src/dashboard/storage.ts';
import { __resetForTests, db } from '../../src/core/database.ts';

beforeEach(() => {
	__resetForTests();
});

function session(overrides: Partial<DashboardSession> = {}): DashboardSession {
	return { id_hash: 'h1', user_id: 'u1', username: 'alex', created_at: 1000, expires_at: 5000, ...overrides };
}

function hashes(): string[] {
	return (db.prepare('SELECT id_hash FROM dashboard_sessions ORDER BY id_hash').all() as { id_hash: string }[]).map(
		(row) => row.id_hash,
	);
}

describe('dashboard session storage', () => {
	it('finds a saved session until it expires', () => {
		createSession(session());

		expect(getSession('h1', 4999)).toEqual(session());
		expect(getSession('h1', 5000)).toBeUndefined();
		expect(getSession('other', 1000)).toBeUndefined();
	});

	it('deletes a session', () => {
		createSession(session());
		createSession(session({ id_hash: 'h2' }));

		deleteSession('h1');

		expect(hashes()).toEqual(['h2']);
	});

	it("deletes every user's expired sessions when one is created", () => {
		createSession(session({ id_hash: 'old', user_id: 'u2', expires_at: 2000 }));
		createSession(session({ id_hash: 'live', user_id: 'u3', expires_at: 9000 }));

		createSession(session({ id_hash: 'new', created_at: 2000, expires_at: 9000 }));

		expect(hashes()).toEqual(['live', 'new']);
	});

	it(`keeps a user's newest ${MAX_SESSIONS_PER_USER} sessions, leaving other users' alone`, () => {
		createSession(session({ id_hash: 'other-user', user_id: 'u2' }));
		for (let i = 0; i < MAX_SESSIONS_PER_USER + 2; i++) {
			createSession(session({ id_hash: `s${String(i).padStart(2, '0')}`, created_at: 1000 + i }));
		}

		const kept = hashes();
		expect(kept).toHaveLength(MAX_SESSIONS_PER_USER + 1);
		expect(kept).toContain('other-user');
		expect(kept).not.toContain('s00');
		expect(kept).not.toContain('s01');
		expect(kept).toContain(`s${MAX_SESSIONS_PER_USER + 1}`);
	});

	it('keeps the later of two sessions created in the same millisecond when the cap is reached', () => {
		for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
			createSession(session({ id_hash: `s${String(i).padStart(2, '0')}`, created_at: 1000 }));
		}

		createSession(session({ id_hash: 'latest', created_at: 1000 }));

		const kept = hashes();
		expect(kept).toHaveLength(MAX_SESSIONS_PER_USER);
		expect(kept).toContain('latest');
		expect(kept).not.toContain('s00');
	});
});
