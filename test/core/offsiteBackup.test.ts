import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	offsiteBackupCheck,
	offsiteBackupCheckFromEnv,
	ownerNotifier,
	STALE_AFTER_MS,
	type OwnerClient,
} from '../../src/core/offsiteBackup.ts';
import { startScheduler, stopScheduler, type ScheduledCheck } from '../../src/core/scheduler.ts';

const POLL_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const PAR_URL = 'https://objectstorage.example.invalid/p/secret-token/n/ns/b/bot-backups/o/';
const NOW = new Date('2026-11-24T12:00:00.000Z');

let identity: string;
let recipient: string;
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
let notifyOwner: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

function writeSnapshot(stamp: string, contents = `contents of ${stamp}`): string {
	const name = `daily-${stamp}.db`;
	fs.writeFileSync(path.join(dir, name), contents);
	return name;
}

let pending: Promise<unknown>[] = [];

// Encrypting goes through WebCrypto, which settles outside the fake clock, so
// each run the scheduler starts is awaited for real before the next poll.
function check(): ScheduledCheck {
	const inner = offsiteBackupCheck({ dir, uploadUrl: PAR_URL, recipient, notifyOwner });
	return {
		name: inner.name,
		run(signal) {
			const run = inner.run(signal);
			pending.push(run.catch(() => {}));
			return run;
		},
	};
}

async function poll(times = 1): Promise<void> {
	for (let i = 0; i < times; i++) {
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await Promise.all(pending.splice(0));
	}
}

function uploads(): { url: string; body: Uint8Array }[] {
	return fetchMock.mock.calls.map(([url, init]) => ({
		url: url as string,
		body: (init as RequestInit).body as Uint8Array,
	}));
}

async function decrypt(body: Uint8Array): Promise<string> {
	const decrypter = new Decrypter();
	decrypter.addIdentity(identity);
	return decrypter.decrypt(body, 'text');
}

beforeAll(async () => {
	identity = await generateX25519Identity();
	recipient = await identityToRecipient(identity);
});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offsite-'));
	fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
	notifyOwner = vi.fn(async () => {});
	vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	pending = [];
});

afterEach(async () => {
	await stopScheduler();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('offsiteBackupCheck', () => {
	it('uploads the newest daily snapshot, encrypted to the recipient, under a name with the attempt’s time', async () => {
		writeSnapshot('2026-11-22T12-00-00.000Z', 'older');
		const newest = writeSnapshot('2026-11-23T12-00-00.000Z', 'newest');
		startScheduler([check()]);

		await poll();

		expect(uploads()).toHaveLength(1);
		const [{ url, body }] = uploads() as [{ url: string; body: Uint8Array }];
		expect(url).toBe(`${PAR_URL}daily-2026-11-23T12-00-00.000Z.sent-2026-11-24T12-01-00.000Z.db.age`);
		expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'PUT' });
		expect(await decrypt(body)).toBe('newest');
		expect(Buffer.from(body).includes('newest')).toBe(false);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining(newest));
	});

	it('sends each snapshot once, also after a restart, then the next one', async () => {
		writeSnapshot('2026-11-23T12-00-00.000Z');
		startScheduler([check()]);
		await poll(3);
		await stopScheduler();
		expect(uploads()).toHaveLength(1);

		startScheduler([check()]);
		await poll();
		expect(uploads()).toHaveLength(1);

		writeSnapshot('2026-11-24T12-05-00.000Z', 'next');
		await poll();
		expect(uploads()).toHaveLength(2);
		expect(await decrypt(uploads()[1]!.body)).toBe('next');
	});

	it('keeps its record of what it sent readable only by its owner', async () => {
		writeSnapshot('2026-11-23T12-00-00.000Z');
		startScheduler([check()]);

		await poll();

		const marker = path.join(dir, 'offsite-upload.json');
		expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({
			snapshot: 'daily-2026-11-23T12-00-00.000Z.db',
			uploadedAt: '2026-11-24T12:01:00.000Z',
		});
		if (process.platform !== 'win32') expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
	});

	it('does nothing without a daily snapshot', async () => {
		startScheduler([check()]);

		await poll();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(console.error).not.toHaveBeenCalled();
	});

	it('logs a refused upload without the PAR_URL, and tries again an hour later under a new name', async () => {
		writeSnapshot('2026-11-23T12-00-00.000Z');
		fetchMock.mockResolvedValue(
			new Response('{"code":"NotAuthenticated","message":"PAR does not exist"}', { status: 401 }),
		);
		startScheduler([check()]);

		await poll(60);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledWith('Off-VM backup check failed:', expect.any(Error));
		const error = vi.mocked(console.error).mock.calls[0]![1] as Error;
		expect(error.message).toContain('HTTP 401');
		expect(error.message).toContain('PAR does not exist');
		expect(error.message).not.toContain('secret-token');

		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		await poll();
		expect(uploads().map(({ url }) => url)).toEqual([
			`${PAR_URL}daily-2026-11-23T12-00-00.000Z.sent-2026-11-24T12-01-00.000Z.db.age`,
			`${PAR_URL}daily-2026-11-23T12-00-00.000Z.sent-2026-11-24T13-01-00.000Z.db.age`,
		]);
		expect(fs.existsSync(path.join(dir, 'offsite-upload.json'))).toBe(true);
	});

	it('stops an upload under way at shutdown without logging it as a failure', async () => {
		writeSnapshot('2026-11-23T12-00-00.000Z');
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
				}),
		);
		startScheduler([check()]);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		// Not poll(): this upload only ends when shutdown aborts it.
		await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

		await stopScheduler();

		expect(console.error).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(dir, 'offsite-upload.json'))).toBe(false);
	});

	it('gives up on an upload that hangs after 2 minutes, logs it, and tries again an hour later', async () => {
		writeSnapshot('2026-11-23T12-00-00.000Z');
		fetchMock.mockImplementationOnce(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
				}),
		);
		startScheduler([check()]);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		// Not poll(): this upload only ends when the timeout aborts it.
		await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		await Promise.all(pending.splice(0));
		expect(console.error).toHaveBeenCalledWith('Off-VM backup check failed:', expect.any(Error));
		expect((vi.mocked(console.error).mock.calls[0]![1] as Error).message).toMatch(/timed out/);

		await poll(60);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fs.existsSync(path.join(dir, 'offsite-upload.json'))).toBe(true);
	});

	it('sends the newest snapshot again when its record is cut off', async () => {
		writeSnapshot('2026-11-23T12-00-00.000Z');
		fs.writeFileSync(path.join(dir, 'offsite-upload.json'), '{"snapshot":"daily-2026-11-23T12-00');
		startScheduler([check()]);

		await poll();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("doesn't send a snapshot again when its record can't be written", async () => {
		writeSnapshot('2026-11-23T12-00-00.000Z');
		// A folder where the record goes: renaming onto it fails.
		fs.mkdirSync(path.join(dir, 'offsite-upload.json', 'x'), { recursive: true });
		startScheduler([check()]);

		await poll();
		expect(console.error).toHaveBeenCalledWith('Off-VM backup check failed:', expect.any(Error));

		await poll(2 * 60);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	describe('when uploads stop', () => {
		beforeEach(() => {
			fetchMock.mockRejectedValue(new TypeError('fetch failed'));
		});

		it(`DMs the owner once the newest copy is over ${STALE_AFTER_MS / HOUR_MS} hours old, then once a day`, async () => {
			fs.writeFileSync(
				path.join(dir, 'offsite-upload.json'),
				JSON.stringify({ snapshot: 'daily-x.db', uploadedAt: new Date(NOW.getTime() - 47 * HOUR_MS).toISOString() }),
			);
			writeSnapshot('2026-11-24T00-00-00.000Z');
			startScheduler([check()]);

			await poll(60);
			expect(notifyOwner).not.toHaveBeenCalled();

			await poll();
			expect(notifyOwner).toHaveBeenCalledTimes(1);
			expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('in 48 hours'));
			expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('2026-11-22T13:00:00.000Z'));

			await poll(24 * 60 - 1);
			expect(notifyOwner).toHaveBeenCalledTimes(1);
			await poll();
			expect(notifyOwner).toHaveBeenCalledTimes(2);

			fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
			await poll(48 * 60);
			expect(notifyOwner).toHaveBeenCalledTimes(2);
		});

		it('counts from the oldest snapshot before the first upload', async () => {
			writeSnapshot('2026-11-22T11-00-00.000Z');
			writeSnapshot('2026-11-24T11-00-00.000Z');
			startScheduler([check()]);

			await poll();

			expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining('none yet'));
		});

		it('logs a DM that fails and goes on', async () => {
			writeSnapshot('2026-11-20T00-00-00.000Z');
			notifyOwner.mockRejectedValue(new Error('Cannot send messages to this user'));
			startScheduler([check()]);

			await poll();

			expect(console.error).toHaveBeenCalledWith(
				'Could not DM the owner that off-VM backups are failing:',
				expect.any(Error),
			);
			expect(console.error).toHaveBeenCalledWith('Off-VM backup check failed:', expect.any(TypeError));
		});
	});

	it('refuses a PAR_URL that isn’t a bucket pre-authenticated request, or a malformed recipient', () => {
		expect(() => offsiteBackupCheck({ dir, uploadUrl: 'http://example.invalid/o/', recipient, notifyOwner })).toThrow(
			/BACKUP_UPLOAD_URL/,
		);
		expect(() =>
			offsiteBackupCheck({ dir, uploadUrl: 'https://example.invalid/p/x/n/ns/b/b/o/name', recipient, notifyOwner }),
		).toThrow(/BACKUP_UPLOAD_URL/);
		expect(() => offsiteBackupCheck({ dir, uploadUrl: PAR_URL, recipient: 'age1nope', notifyOwner })).toThrow(
			/BACKUP_AGE_RECIPIENT/,
		);
	});
});

describe('offsiteBackupCheckFromEnv', () => {
	it('is off, quietly, without either value (a local dev bot)', () => {
		expect(offsiteBackupCheckFromEnv({}, dir, notifyOwner)).toBeNull();
		expect(console.error).not.toHaveBeenCalled();
	});

	it('is off, and says so, with only one of them', () => {
		expect(offsiteBackupCheckFromEnv({ BACKUP_UPLOAD_URL: PAR_URL }, dir, notifyOwner)).toBeNull();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('set both'));
	});

	it('is off, and says which value is wrong without quoting the PAR_URL', () => {
		const url = 'not a url, secret-token';
		expect(
			offsiteBackupCheckFromEnv({ BACKUP_UPLOAD_URL: url, BACKUP_AGE_RECIPIENT: recipient }, dir, notifyOwner),
		).toBeNull();
		const message = vi.mocked(console.error).mock.calls[0]![0] as string;
		expect(message).toContain('BACKUP_UPLOAD_URL');
		expect(message).not.toContain('secret-token');
	});

	it('returns the check with both', () => {
		const result = offsiteBackupCheckFromEnv(
			{ BACKUP_UPLOAD_URL: PAR_URL, BACKUP_AGE_RECIPIENT: recipient },
			dir,
			notifyOwner,
		);
		expect(result?.name).toBe('Off-VM backup');
	});
});

describe('ownerNotifier', () => {
	function client(owner: unknown) {
		return {
			application: { fetch: vi.fn(async () => ({ owner })) },
			users: { send: vi.fn(async () => ({})) },
		};
	}

	it('DMs the user who owns the application', async () => {
		const fake = client({ id: 'user-1' });
		await ownerNotifier(fake as unknown as OwnerClient)('hello');
		expect(fake.users.send).toHaveBeenCalledWith('user-1', 'hello');
	});

	it("DMs the team's owner, not the team", async () => {
		const fake = client({ id: 'team-1', ownerId: 'user-2' });
		await ownerNotifier(fake as unknown as OwnerClient)('hello');
		expect(fake.users.send).toHaveBeenCalledWith('user-2', 'hello');
	});

	it('throws when Discord names no owner', async () => {
		const fake = client(null);
		await expect(ownerNotifier(fake as unknown as OwnerClient)('hello')).rejects.toThrow(/owns the application/);
		expect(fake.users.send).not.toHaveBeenCalled();
	});
});
