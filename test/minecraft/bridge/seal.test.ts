import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	deriveKeys,
	type Envelope,
	MAX_CLOCK_SKEW_MS,
	newBridgeSecret,
	open,
	parseEnvelope,
	ReplayGuard,
	type SealContext,
	seal,
} from '../../../src/minecraft/bridge/seal.ts';

const NOW = 1_790_000_000_000;
const BRIDGE = 'AAAAAAAAAAAAAAAAAAAAAA';
const POLL: SealContext = { bridgeId: BRIDGE, route: 'poll' };
const keys = deriveKeys(newBridgeSecret());

// Flips one character of a base64url string, keeping it valid base64url.
function flip(text: string, at = 0): string {
	const swapped = text[at] === 'A' ? 'B' : 'A';
	return text.slice(0, at) + swapped + text.slice(at + 1);
}

describe('deriveKeys', () => {
	// Pinned: helpers already running elsewhere derive the same keys, so a
	// change here would lock every paired bridge out.
	it('derives the same two keys from a secret as every earlier version', () => {
		const derived = deriveKeys(Buffer.alloc(32, 7).toString('base64url'));
		expect(derived.request.toString('hex')).toBe('494f8e655482959fcb2263e5108397c6fa709de77aea7510d88969015fef8e19');
		expect(derived.response.toString('hex')).toBe('6782cdd2750b221d21cf4250105559df764a1642655eb0125d1d1bfd4b18acfa');
	});

	it('accepts a new secret, and gives each secret its own keys', () => {
		const secret = newBridgeSecret();
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const derived = deriveKeys(secret);
		expect(derived.request).toHaveLength(32);
		expect(derived.response).toHaveLength(32);
		expect(derived.request.equals(derived.response)).toBe(false);
		expect(deriveKeys(newBridgeSecret()).request.equals(derived.request)).toBe(false);
	});

	it.each([
		['too short', Buffer.alloc(31).toString('base64url')],
		['too long', Buffer.alloc(33).toString('base64url')],
		['not base64url', Buffer.alloc(32).toString('base64')],
		['empty', ''],
	])('refuses a secret that is %s', (_, secret) => {
		expect(() => deriveKeys(secret)).toThrow(TypeError);
	});
});

describe('seal and open', () => {
	it('opens a message sealed by an earlier version (the wire format is pinned)', () => {
		const sealed: Envelope = {
			v: 1,
			bridge: BRIDGE,
			iv: '5fYb5iNoDeT4bxxW',
			box: '-DCrZuf6XIDGoGtu4xyinSpNJ9LPoAyCrD2B4VctyzGPneiBANZujJsZWO8U6xtO973MKCH-A9YDIw',
		};
		const pinnedKeys = deriveKeys(Buffer.alloc(32, 7).toString('base64url'));
		expect(open(pinnedKeys, 'request', POLL, sealed)).toEqual({
			ok: true,
			message: { hello: 'é🙂' },
			nonce: '5fYb5iNoDeT4bxxW',
			sentAt: NOW,
		});
	});

	it('round-trips a request, giving its time and its IV as the nonce', () => {
		const sealed = seal(keys, 'request', POLL, { events: [{ type: 'up' }] }, NOW);
		expect(sealed.bridge).toBe(BRIDGE);
		expect(parseEnvelope(JSON.parse(JSON.stringify(sealed)))).toEqual(sealed);
		expect(open(keys, 'request', POLL, sealed)).toEqual({
			ok: true,
			message: { events: [{ type: 'up' }] },
			nonce: sealed.iv,
			sentAt: NOW,
		});
	});

	it('round-trips a response bound to the request it answers', () => {
		const request = seal(keys, 'request', POLL, null, NOW);
		const answers = { ...POLL, replyTo: request.iv };
		const response = seal(keys, 'response', answers, { chat: [] }, NOW + 1);
		expect(open(keys, 'response', answers, response)).toMatchObject({ ok: true, message: { chat: [] } });
	});

	it('hides the message and uses a new IV each time', () => {
		const first = seal(keys, 'request', POLL, { text: 'secret chat' }, NOW);
		const second = seal(keys, 'request', POLL, { text: 'secret chat' }, NOW);
		expect(JSON.stringify(first)).not.toContain('secret chat');
		expect(first.iv).not.toBe(second.iv);
		expect(first.box).not.toBe(second.box);
	});

	it('round-trips a message with no body', () => {
		expect(open(keys, 'request', POLL, seal(keys, 'request', POLL, undefined, NOW))).toMatchObject({
			ok: true,
			message: undefined,
		});
	});

	describe('refuses as forged', () => {
		const sealed = seal(keys, 'request', POLL, { text: 'hi' }, NOW);

		it('a changed ciphertext', () => {
			expect(open(keys, 'request', POLL, { ...sealed, box: flip(sealed.box) })).toEqual({
				ok: false,
				reason: 'forged',
			});
		});

		it('a changed tag', () => {
			const at = sealed.box.length - 2;
			expect(open(keys, 'request', POLL, { ...sealed, box: flip(sealed.box, at) })).toEqual({
				ok: false,
				reason: 'forged',
			});
		});

		it('a changed IV', () => {
			expect(open(keys, 'request', POLL, { ...sealed, iv: flip(sealed.iv) })).toEqual({ ok: false, reason: 'forged' });
		});

		it("another secret's keys", () => {
			expect(open(deriveKeys(newBridgeSecret()), 'request', POLL, sealed)).toEqual({ ok: false, reason: 'forged' });
		});

		it('a message moved to another bridge', () => {
			const other = { bridgeId: 'BBBBBBBBBBBBBBBBBBBBBB', route: 'poll' };
			expect(open(keys, 'request', other, { ...sealed, bridge: other.bridgeId })).toEqual({
				ok: false,
				reason: 'forged',
			});
		});

		it('a message moved to another route', () => {
			expect(open(keys, 'request', { ...POLL, route: 'link' }, sealed)).toEqual({ ok: false, reason: 'forged' });
		});

		it('a response sent back as a request', () => {
			const response = seal(keys, 'response', POLL, { text: 'hi' }, NOW);
			expect(open(keys, 'request', POLL, response)).toEqual({ ok: false, reason: 'forged' });
		});

		it('a request opened as a response, even under the same key', () => {
			const oneKey = { request: keys.request, response: keys.request };
			expect(open(oneKey, 'response', POLL, sealed)).toEqual({ ok: false, reason: 'forged' });
		});

		it('a response given as the answer to another request', () => {
			const first = seal(keys, 'request', POLL, null, NOW);
			const second = seal(keys, 'request', POLL, null, NOW);
			const response = seal(keys, 'response', { ...POLL, replyTo: first.iv }, { chat: [] }, NOW);
			expect(open(keys, 'response', { ...POLL, replyTo: second.iv }, response)).toEqual({
				ok: false,
				reason: 'forged',
			});
		});
	});

	describe('refuses as malformed', () => {
		const sealed = seal(keys, 'request', POLL, null, NOW);

		it('an envelope for another bridge than the one asked for', () => {
			expect(open(keys, 'request', POLL, { ...sealed, bridge: 'BBBBBBBBBBBBBBBBBBBBBB' })).toEqual({
				ok: false,
				reason: 'malformed',
			});
		});

		it('an IV of the wrong length', () => {
			expect(open(keys, 'request', POLL, { ...sealed, iv: 'AAAA' })).toEqual({ ok: false, reason: 'malformed' });
		});

		it('a box shorter than a tag', () => {
			expect(open(keys, 'request', POLL, { ...sealed, box: 'AAAA' })).toEqual({ ok: false, reason: 'malformed' });
		});

		// Only a bug on the sending end seals these, so they're sealed by hand
		// here, with the additional data written out separately from seal.ts:
		// a change to its layout fails this too.
		function sealRaw(plaintext: string): Envelope {
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', keys.request, iv, { authTagLength: 16 });
			const ivText = iv.toString('base64url');
			cipher.setAAD(Buffer.from(JSON.stringify(['mcbridge', 1, 'request', BRIDGE, 'poll', null, ivText])));
			const box = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
			return { v: 1, bridge: BRIDGE, iv: ivText, box: box.toString('base64url') };
		}

		it('opens a hand-sealed body, so the additional data is as written here', () => {
			expect(open(keys, 'request', POLL, sealRaw(`{"t":${NOW},"m":"hi"}`))).toMatchObject({ ok: true, message: 'hi' });
		});

		it.each([
			['plaintext that is not JSON', 'not json'],
			['a body that is not an object', `[${NOW}]`],
			['a body of null', 'null'],
			['no time', '{"m":"hi"}'],
			['a time that is not a whole number', `{"t":${NOW}.5}`],
			['a time that is not a number', `{"t":"${NOW}"}`],
			['a time past safe integers', '{"t":9007199254740993}'],
		])('%s, even under a valid tag', (_, plaintext) => {
			expect(open(keys, 'request', POLL, sealRaw(plaintext))).toEqual({ ok: false, reason: 'malformed' });
		});
	});
});

describe('parseEnvelope', () => {
	const sealed = seal(keys, 'request', POLL, null, NOW);

	it.each([
		['not an object', 'text'],
		['null', null],
		['another version', { ...sealed, v: 2 }],
		['no bridge', { ...sealed, bridge: undefined }],
		['a bridge id of the wrong length', { ...sealed, bridge: 'AAAA' }],
		['a bridge id that is not base64url', { ...sealed, bridge: 'AAAAAAAAAAAAAAAAAAAA+/' }],
		['an IV that is not base64url', { ...sealed, iv: '5fYb5iNoDeT4bx+/' }],
		['an IV of the wrong length', { ...sealed, iv: 'AAAA' }],
		['an IV that is not a string', { ...sealed, iv: 12 }],
		['a box with padding', { ...sealed, box: `${sealed.box}=` }],
		['a box shorter than a tag', { ...sealed, box: 'AAAA' }],
		['a box that is not a string', { ...sealed, box: [] }],
	])('refuses %s', (_, body) => {
		expect(parseEnvelope(body)).toBeUndefined();
	});

	it('keeps only the envelope’s own fields', () => {
		expect(parseEnvelope({ ...sealed, extra: 'x' })).toEqual(sealed);
	});
});

describe('ReplayGuard', () => {
	it('refuses as stale anything sealed before it was made, so a restart lets no capture back in', () => {
		const guard = new ReplayGuard(NOW);
		expect(guard.check('before', NOW - 1, NOW + 1000)).toBe('stale');
		expect(guard.check('at start', NOW, NOW + 1000)).toBe('ok');
	});

	it('accepts a nonce once, then refuses it as replayed', () => {
		const guard = new ReplayGuard(0);
		expect(guard.check('a', NOW, NOW)).toBe('ok');
		expect(guard.check('a', NOW, NOW + 1000)).toBe('replayed');
		expect(guard.check('b', NOW, NOW + 1000)).toBe('ok');
	});

	it('accepts a time up to 5 minutes either side, and refuses one further', () => {
		const guard = new ReplayGuard(0);
		expect(guard.check('past', NOW - MAX_CLOCK_SKEW_MS, NOW)).toBe('ok');
		expect(guard.check('future', NOW + MAX_CLOCK_SKEW_MS, NOW)).toBe('ok');
		expect(guard.check('too old', NOW - MAX_CLOCK_SKEW_MS - 1, NOW)).toBe('stale');
		expect(guard.check('too new', NOW + MAX_CLOCK_SKEW_MS + 1, NOW)).toBe('stale');
	});

	it('refuses a replay as stale once the window has passed, after forgetting its nonce', () => {
		const guard = new ReplayGuard(0);
		guard.check('a', NOW, NOW);
		expect(guard.check('a', NOW, NOW + MAX_CLOCK_SKEW_MS + 1)).toBe('stale');
	});

	it('forgets nonces that would be stale anyway, at most once a minute', () => {
		const guard = new ReplayGuard(0);
		guard.check('old', NOW, NOW);
		guard.check('ahead', NOW + MAX_CLOCK_SKEW_MS, NOW);
		expect(guard.__sizeForTests()).toBe(2);

		// Under a minute since the last prune: nothing is scanned yet.
		guard.check('new', NOW + 30_000, NOW + 30_000);
		expect(guard.__sizeForTests()).toBe(3);

		// 'old' is now out of the window; 'ahead' and 'new' are still in it.
		const later = NOW + MAX_CLOCK_SKEW_MS + 10_000;
		guard.check('newest', later, later);
		expect(guard.__sizeForTests()).toBe(3);
		expect(guard.check('ahead', NOW + MAX_CLOCK_SKEW_MS, later)).toBe('replayed');
	});
});
