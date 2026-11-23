import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Its own file: each case opens database.ts on a database file of its own.
let dir: string;
let dbPath: string;

async function openDatabase() {
	vi.resetModules();
	vi.stubEnv('DB_PATH', dbPath);
	return import('../../../src/core/database.ts');
}

function modeOf(file: string): number {
	return fs.statSync(file).mode & 0o777;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'database-permissions-'));
	dbPath = path.join(dir, 'bot.db');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

// File modes mean nothing on Windows.
describe.skipIf(process.platform === 'win32')('database file permissions', () => {
	it('creates a new database, and its -wal and -shm files, readable only by its owner', async () => {
		const { db, closeDatabase } = await openDatabase();
		db.exec('CREATE TABLE IF NOT EXISTS probe (x)');

		expect(modeOf(dbPath)).toBe(0o600);
		expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
		expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
		closeDatabase();
	});

	// Production's bot.db, and any -wal and -shm left by a crash, predate this.
	it('makes an existing database and its leftover -wal and -shm files readable only by its owner', async () => {
		const existing = new Database(dbPath);
		existing.pragma('journal_mode = WAL');
		existing.exec('CREATE TABLE kept (x); INSERT INTO kept VALUES (1)');
		for (const name of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.chmodSync(name, 0o644);

		const { db, closeDatabase } = await openDatabase();

		expect(modeOf(dbPath)).toBe(0o600);
		expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
		expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
		expect(db.prepare('SELECT x FROM kept').all()).toEqual([{ x: 1 }]);
		closeDatabase();
		existing.close();
	});

	it("logs, and still opens the database, when it can't change the mode", async () => {
		fs.writeFileSync(dbPath, '');
		const chmod = fs.chmodSync;
		// Only the database's own files: the snapshot taken before migrating is
		// the bot's own new file.
		vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
			if (String(file).startsWith(dbPath)) {
				throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
			}
			chmod(file, mode);
		});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		const { db, closeDatabase } = await openDatabase();

		expect(error).toHaveBeenCalledWith(expect.stringContaining(dbPath), expect.any(Error));
		expect(db.pragma('user_version', { simple: true })).toBeGreaterThan(0);
		closeDatabase();
	});
});
