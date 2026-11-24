import { Encrypter } from 'age-encryption';
import fs from 'node:fs';
import path from 'node:path';
import { dailySnapshots, stampOf } from './backup.ts';
import type { ScheduledCheck } from './scheduler.ts';

// Decision 0011: daily snapshots, encrypted to the owner's age public key, go
// to Oracle Object Storage through a write-only pre-authenticated request.

const HOUR_MS = 60 * 60 * 1000;
// Like a failed daily snapshot: tried again after this, not every 60 s poll.
const RETRY_AFTER_FAILURE_MS = HOUR_MS;
/** The newest copy uploaded is older than this: the owner is told by DM. */
export const STALE_AFTER_MS = 48 * HOUR_MS;
const WARN_EVERY_MS = 24 * HOUR_MS;
// A few megabytes at most; a hung connection shouldn't hold the check for good.
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

// Beside the snapshots: the daily check skips once the day's snapshot exists,
// so the upload keeps its own record of what it has sent, across restarts.
const MARKER = 'offsite-upload.json';

interface Marker {
	/** The snapshot's file name. */
	snapshot: string;
	uploadedAt: string;
}

function readMarker(dir: string): Marker | null {
	try {
		const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as Partial<Marker>;
		return typeof marker.snapshot === 'string' && typeof marker.uploadedAt === 'string'
			? { snapshot: marker.snapshot, uploadedAt: marker.uploadedAt }
			: null;
	} catch {
		// None yet, or cut off: the newest snapshot is sent again, which costs one upload.
		return null;
	}
}

function writeMarker(dir: string, marker: Marker): void {
	const file = path.join(dir, MARKER);
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(marker), { mode: 0o600 });
	fs.renameSync(`${file}.tmp`, file);
}

/** Sends the owner a DM; how the bot reaches them is the caller's. */
export type NotifyOwner = (text: string) => Promise<void>;

export interface OffsiteBackupOptions {
	/** Where the daily snapshots are (`backupDirectory()`). */
	dir: string;
	/** The bucket's write-only PAR, ending in `/o/`; the object's name is appended. */
	uploadUrl: string;
	/** The owner's age public key (`age1…`). */
	recipient: string;
	notifyOwner: NotifyOwner;
}

/**
 * The scheduled check that uploads the newest daily snapshot not yet sent.
 * Throws if the recipient or URL is malformed, so a typo in `.env` shows at
 * startup rather than as an hourly failure.
 */
export function offsiteBackupCheck({ dir, uploadUrl, recipient, notifyOwner }: OffsiteBackupOptions): ScheduledCheck {
	// The messages never quote the URL: it's a secret, like the bot's token.
	const url = URL.parse(uploadUrl);
	if (url?.protocol !== 'https:' || !url.pathname.endsWith('/o/')) {
		throw new Error("BACKUP_UPLOAD_URL isn't a bucket pre-authenticated request (https://…/o/)");
	}
	const encrypter = new Encrypter();
	try {
		encrypter.addRecipient(recipient);
	} catch (error) {
		throw new Error("BACKUP_AGE_RECIPIENT isn't an age public key (age1…)", { cause: error });
	}
	let lastFailureAt = -Infinity;
	let lastWarnedAt = -Infinity;

	async function upload(signal: AbortSignal, now: number): Promise<void> {
		const newest = dailySnapshots(dir).at(-1);
		if (!newest) return;
		const snapshot = path.basename(newest.file);
		if (readMarker(dir)?.snapshot === snapshot) return;
		const encrypted = await encrypter.encrypt(fs.readFileSync(newest.file));
		// A new name each attempt: the retention rule refuses a second PUT to a
		// name for 30 days, so retrying under the same name after a timeout whose
		// upload did reach Oracle would fail for that whole time.
		const name = `${snapshot.replace(/\.db$/, '')}.sent-${stampOf(new Date(now))}.db.age`;
		const response = await fetch(`${uploadUrl}${encodeURIComponent(name)}`, {
			method: 'PUT',
			body: encrypted,
			signal: AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
		});
		if (!response.ok) {
			const detail = (await response.text().catch(() => '')).slice(0, 200);
			throw new Error(`Object Storage refused the upload: HTTP ${response.status} ${detail}`.trim());
		}
		writeMarker(dir, { snapshot, uploadedAt: new Date(now).toISOString() });
		console.log(`Uploaded an encrypted copy of ${snapshot} as ${name}`);
	}

	// Uploads that stop unnoticed (an expired PAR, a full bucket) are the worst
	// case: the lifecycle policy keeps deleting copies, so after 60 days none
	// are left off the VM. Nobody reads the journal unprompted.
	async function warnIfStale(now: number): Promise<void> {
		if (now - lastWarnedAt < WARN_EVERY_MS) return;
		const marker = readMarker(dir);
		// Before the first upload, from the oldest snapshot there was to send.
		const since = marker ? new Date(marker.uploadedAt) : dailySnapshots(dir).at(0)?.takenAt;
		if (!since || now - since.getTime() <= STALE_AFTER_MS) return;
		lastWarnedAt = now;
		const hours = Math.floor((now - since.getTime()) / HOUR_MS);
		const what = marker ? 'the last one' : 'none yet; the oldest snapshot to send';
		try {
			await notifyOwner(
				`No encrypted copy of \`bot.db\` has reached Object Storage in ${hours} hours (${what} was ` +
					`${since.toISOString()}). The bot's journal has why: \`journalctl -u discordbotshrimp\`.`,
			);
		} catch (error) {
			console.error('Could not DM the owner that off-VM backups are failing:', error);
		}
	}

	return {
		name: 'Off-VM backup',
		async run(signal) {
			const now = Date.now();
			let failure: unknown = null;
			if (now - lastFailureAt >= RETRY_AFTER_FAILURE_MS) {
				try {
					await upload(signal, now);
				} catch (error) {
					// Shutdown stopped it; the next start sends it.
					if (signal.aborted) return;
					lastFailureAt = now;
					failure = error;
				}
			}
			await warnIfStale(now);
			if (failure) throw failure;
		},
	};
}

/**
 * The check from `.env`'s BACKUP_UPLOAD_URL and BACKUP_AGE_RECIPIENT, or null
 * without them (a local dev bot), logged if only one is set or one is
 * malformed: the bot runs without off-VM copies rather than not at all.
 */
export function offsiteBackupCheckFromEnv(
	env: NodeJS.ProcessEnv,
	dir: string,
	notifyOwner: NotifyOwner,
): ScheduledCheck | null {
	const uploadUrl = env['BACKUP_UPLOAD_URL'];
	const recipient = env['BACKUP_AGE_RECIPIENT'];
	if (!uploadUrl && !recipient) return null;
	if (!uploadUrl || !recipient) {
		console.error('Off-VM backups are off: set both BACKUP_UPLOAD_URL and BACKUP_AGE_RECIPIENT in .env.');
		return null;
	}
	try {
		return offsiteBackupCheck({ dir, uploadUrl, recipient, notifyOwner });
	} catch (error) {
		console.error(`Off-VM backups are off: ${(error as Error).message}.`);
		return null;
	}
}

/** What ownerNotifier uses of the client; discord.js's Client fits it. */
export interface OwnerClient {
	application: { fetch(): Promise<{ owner: { id: string } | { ownerId: string | null } | null }> };
	users: { send(userId: string, content: string): Promise<unknown> };
}

/** DMs the bot application's owner, or its team's owner. */
export function ownerNotifier(client: OwnerClient): NotifyOwner {
	return async (text) => {
		const { owner } = await client.application.fetch();
		const ownerId = owner && ('ownerId' in owner ? owner.ownerId : owner.id);
		if (!ownerId) throw new Error("Discord didn't say who owns the application");
		await client.users.send(ownerId, text);
	};
}
