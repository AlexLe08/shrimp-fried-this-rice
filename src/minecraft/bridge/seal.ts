import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
// Type-only, so erased: the helper never loads the bot's storage or database.
import type { BridgeKeys } from '../storage.ts';

// How the helper's messages to the bot, and the bot's answers, are sealed
// (decision 0009; the plan's A8, "Endpoint safety"). Cloudflare's edge
// decrypts HTTPS (decision 0008), so each body is encrypted and
// authenticated on top with AES-256-GCM under a key derived from the pairing
// secret: that proves a request came from the paired helper and hides relayed
// chat, and the secret never crosses the wire. Both ends use this file, and
// only node:crypto, so mcbridge stays dependency-free.
//
// The wire format must stay readable by helpers already running elsewhere:
// a change that isn't compatible bumps VERSION, and the bot keeps the old one
// until those helpers have updated.

const VERSION = 1;
const SECRET_BYTES = 32;
const KEY_BYTES = 32;
// GCM's recommended IV length (NIST SP 800-38D). Random IVs stay safe for 2^32
// messages per key, far beyond a bridge's rate limit over its secret's life.
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** How far a sealed message's time may be from the receiver's clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const BASE64URL = /^[A-Za-z0-9_-]*$/;
// createBridge's ids: 16 random bytes, base64url.
const BRIDGE_ID = /^[A-Za-z0-9_-]{22}$/;

/** Whether `id` looks like a bridge's id, as createBridge makes them. */
export function isBridgeId(id: string): boolean {
	return BRIDGE_ID.test(id);
}

export type Direction = 'request' | 'response';

/** A sealed body as sent: the bridge's id in the clear (it picks the keys and the rate limit), the rest opaque. */
export interface Envelope {
	v: typeof VERSION;
	bridge: string;
	/** The IV, also the message's nonce for replay checks. */
	iv: string;
	/** The ciphertext, then GCM's tag. */
	box: string;
}

/**
 * What a message is bound to besides its key. Opening with any other value
 * fails, so a sealed message can't be moved to another bridge or route, and a
 * response can't be passed off as the answer to another request.
 */
export interface SealContext {
	bridgeId: string;
	/** The endpoint's route, such as `poll`. */
	route: string;
	/** For a response: the `iv` of the request it answers. */
	replyTo?: string;
}

export type Opened =
	{ ok: true; message: unknown; nonce: string; sentAt: number } | { ok: false; reason: 'malformed' | 'forged' };

/** A new pairing secret: 32 random bytes, base64url, for the helper's config. */
export function newBridgeSecret(): string {
	return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * The two keys a secret gives, one per direction, so a sealed response can't
 * be sent back as a request. The secret is already uniformly random, so HKDF
 * needs no salt (RFC 5869, section 3.1).
 */
export function deriveKeys(secret: string): BridgeKeys {
	const ikm = decodeBase64url(secret);
	if (ikm?.length !== SECRET_BYTES) throw new TypeError('A bridge secret is 32 bytes, base64url');
	const derive = (direction: Direction) =>
		Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), `mcbridge v${VERSION} ${direction}`, KEY_BYTES));
	return { request: derive('request'), response: derive('response') };
}

export function seal(
	keys: BridgeKeys,
	direction: Direction,
	context: SealContext,
	message: unknown,
	now: number,
): Envelope {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', keys[direction], iv, { authTagLength: TAG_BYTES });
	cipher.setAAD(additionalData(direction, context, iv.toString('base64url')));
	const plaintext = Buffer.from(JSON.stringify({ t: now, m: message }));
	const box = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
	return { v: VERSION, bridge: context.bridgeId, iv: iv.toString('base64url'), box: box.toString('base64url') };
}

/**
 * Checks and decrypts a sealed message. It doesn't check the time: a request
 * from a helper whose clock is off still opens, so the bot can answer it,
 * sealed, with its own time (see ReplayGuard).
 */
export function open(keys: BridgeKeys, direction: Direction, context: SealContext, envelope: Envelope): Opened {
	if (envelope.bridge !== context.bridgeId) return { ok: false, reason: 'malformed' };
	const iv = decodeBase64url(envelope.iv);
	const box = decodeBase64url(envelope.box);
	if (iv?.length !== IV_BYTES || !box || box.length < TAG_BYTES) return { ok: false, reason: 'malformed' };

	// An explicit tag length, or setAuthTag would accept a truncated tag
	// (Node 24's crypto docs; DEP0182).
	const decipher = createDecipheriv('aes-256-gcm', keys[direction], iv, { authTagLength: TAG_BYTES });
	decipher.setAAD(additionalData(direction, context, envelope.iv));
	decipher.setAuthTag(box.subarray(box.length - TAG_BYTES));
	let plaintext: Buffer;
	try {
		plaintext = Buffer.concat([decipher.update(box.subarray(0, box.length - TAG_BYTES)), decipher.final()]);
	} catch {
		return { ok: false, reason: 'forged' };
	}

	// Past the tag check, only a bug on the sending end gets here.
	let body: unknown;
	try {
		body = JSON.parse(plaintext.toString('utf8'));
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (typeof body !== 'object' || body === null || !('t' in body) || !Number.isSafeInteger(body.t)) {
		return { ok: false, reason: 'malformed' };
	}
	return { ok: true, message: 'm' in body ? body.m : undefined, nonce: envelope.iv, sentAt: body.t as number };
}

/**
 * The envelope from a parsed JSON body, or `undefined` if it isn't one. The
 * endpoint checks this before looking anything up or decrypting.
 */
export function parseEnvelope(body: unknown): Envelope | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const { v, bridge, iv, box } = body as Record<string, unknown>;
	if (v !== VERSION || typeof bridge !== 'string' || typeof iv !== 'string' || typeof box !== 'string') {
		return undefined;
	}
	if (!BRIDGE_ID.test(bridge) || decodeBase64url(iv)?.length !== IV_BYTES) return undefined;
	const sealed = decodeBase64url(box);
	if (!sealed || sealed.length < TAG_BYTES) return undefined;
	return { v, bridge, iv, box };
}

// A JSON array, so no value can run into the next one.
function additionalData(direction: Direction, context: SealContext, iv: string): Buffer {
	return Buffer.from(
		JSON.stringify(['mcbridge', VERSION, direction, context.bridgeId, context.route, context.replyTo ?? null, iv]),
	);
}

// Buffer.from(…, 'base64url') skips characters it doesn't know, so text that
// isn't strictly base64url is refused rather than half-read.
function decodeBase64url(text: string): Buffer | undefined {
	if (!BASE64URL.test(text)) return undefined;
	const bytes = Buffer.from(text, 'base64url');
	return bytes.toString('base64url') === text ? bytes : undefined;
}

/**
 * Refuses a message whose time is more than MAX_CLOCK_SKEW_MS from the
 * receiver's clock, or whose nonce was already seen in that window, so a
 * captured request can't be sent again. A nonce is remembered only until its
 * message would be refused as stale anyway.
 *
 * Nonces are kept in memory only, so a restart (every deploy) forgets them.
 * So a message sealed before the guard was made is stale too: a request
 * captured before a restart can't be replayed after it. A helper that sealed
 * one just before gets the bot's time in the sealed answer and seals again.
 *
 * If the clock steps back (an NTP correction), a nonce already forgotten can
 * fall inside the window again and be accepted once more. Rare, and holding
 * the clock at the latest time seen would instead refuse every request after
 * a wrong step forward, so it's accepted.
 */
export class ReplayGuard {
	#seen = new Map<string, number>();
	#nextPruneAt = 0;
	readonly #notBefore: number;

	/** `startedAt`: when this process started, so nothing sealed before it opens. */
	constructor(startedAt: number) {
		this.#notBefore = startedAt;
	}

	check(nonce: string, sentAt: number, now: number): 'ok' | 'stale' | 'replayed' {
		if (sentAt < this.#notBefore || Math.abs(now - sentAt) > MAX_CLOCK_SKEW_MS) return 'stale';
		this.#prune(now);
		if (this.#seen.has(nonce)) return 'replayed';
		this.#seen.set(nonce, sentAt);
		return 'ok';
	}

	// At most once a minute, so a burst of requests doesn't scan the map each time.
	#prune(now: number): void {
		if (now < this.#nextPruneAt) return;
		this.#nextPruneAt = now + 60_000;
		for (const [nonce, sentAt] of this.#seen) {
			if (now - sentAt > MAX_CLOCK_SKEW_MS) this.#seen.delete(nonce);
		}
	}

	__sizeForTests(): number {
		return this.#seen.size;
	}
}
