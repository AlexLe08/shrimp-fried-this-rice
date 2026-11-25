import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetForTests } from '../../src/core/database.ts';
import { deriveKeys, newBridgeSecret } from '../../src/minecraft/bridge/seal.ts';
import {
	LINK_CODE_TTL_MS,
	LinkCodes,
	MAX_WRONG_TRIES,
	answerLinkReport,
	readLinkReport,
} from '../../src/minecraft/linking.ts';
import { createBridge, getBridgeLinks, getLink, saveLink, setLinkPicture } from '../../src/minecraft/storage.ts';

// The codes `randomInt` gives next, so a collision can be made to happen;
// the real one once they run out.
const nextRandom: number[] = [];
vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	return {
		...actual,
		randomInt: (min: number, max: number) => nextRandom.shift() ?? actual.randomInt(min, max),
	};
});

const STARTED = 1_790_000_000_000;
const MOJANG_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const OFFLINE_UUID = 'a01e3843-e521-3998-958a-f459800e4d11';
let time = STARTED;
const now = () => time;

beforeEach(() => {
	__resetForTests();
	time = STARTED;
	nextRandom.length = 0;
});

function bridge(): string {
	return createBridge({
		guildId: 'g1',
		chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
		alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
		keys: deriveKeys(newBridgeSecret()),
		serverName: 'Survival',
		now: time,
	}).id;
}

describe('LinkCodes', () => {
	it('gives six digits, zeros kept', () => {
		nextRandom.push(42);
		expect(new LinkCodes(now).issue('b1', 'Steve', 'u1')).toBe('000042');
		expect(new LinkCodes(now).issue('b1', 'Steve', 'u1')).toMatch(/^\d{6}$/);
	});

	it('names whose code it is, for the name compared without case, and is used up only when asked', () => {
		const codes = new LinkCodes(now);
		const code = codes.issue('b1', 'Steve', 'u1');

		expect(codes.check('b1', 'STEVE', code, false)).toEqual({ kind: 'right', userId: 'u1' });
		expect(codes.check('b1', 'steve', code, true)).toEqual({ kind: 'right', userId: 'u1' });
		expect(codes.check('b1', 'Steve', code, true)).toEqual({ kind: 'none' });
	});

	it('keeps a code to its bridge and name', () => {
		const codes = new LinkCodes(now);
		const code = codes.issue('b1', 'Steve', 'u1');

		expect(codes.check('b2', 'Steve', code, false)).toEqual({ kind: 'none' });
		expect(codes.check('b1', 'Alex', code, false)).toEqual({ kind: 'none' });
	});

	it('lasts 10 minutes', () => {
		const codes = new LinkCodes(now);
		const code = codes.issue('b1', 'Steve', 'u1');

		time += LINK_CODE_TTL_MS - 1;
		expect(codes.check('b1', 'Steve', code, false)).toEqual({ kind: 'right', userId: 'u1' });
		time += 1;
		expect(codes.check('b1', 'Steve', code, false)).toEqual({ kind: 'none' });
	});

	it("replaces the member's own earlier code, but not another member's", () => {
		const codes = new LinkCodes(now);
		nextRandom.push(111111, 222222, 333333);
		codes.issue('b1', 'Steve', 'u1');
		codes.issue('b1', 'Steve', 'u2');
		codes.issue('b1', 'Steve', 'u1');

		expect(codes.check('b1', 'Steve', '111111', false)).toEqual({ kind: 'wrong', voided: false });
		expect(codes.check('b1', 'Steve', '222222', false)).toEqual({ kind: 'right', userId: 'u2' });
		expect(codes.check('b1', 'Steve', '333333', false)).toEqual({ kind: 'right', userId: 'u1' });
	});

	it("never gives one member another's code for the same name", () => {
		const codes = new LinkCodes(now);
		nextRandom.push(123456, 123456, 654321);

		expect(codes.issue('b1', 'Steve', 'u1')).toBe('123456');
		expect(codes.issue('b1', 'Steve', 'u2')).toBe('654321');
	});

	it(`voids every code for the name after ${MAX_WRONG_TRIES} wrong ones`, () => {
		const codes = new LinkCodes(now);
		const first = codes.issue('b1', 'Steve', 'u1');
		const second = codes.issue('b1', 'Steve', 'u2');
		const other = codes.issue('b1', 'Alex', 'u1');
		const wrong = ['000000', '999999'].find((code) => code !== first && code !== second)!;

		for (let i = 1; i < MAX_WRONG_TRIES; i++) {
			expect(codes.check('b1', 'Steve', wrong, false)).toEqual({ kind: 'wrong', voided: false });
		}
		// A right one in between doesn't reset the count.
		expect(codes.check('b1', 'Steve', first, false)).toEqual({ kind: 'right', userId: 'u1' });
		expect(codes.check('b1', 'Steve', wrong, false)).toEqual({ kind: 'wrong', voided: true });

		expect(codes.check('b1', 'Steve', first, false)).toEqual({ kind: 'none' });
		expect(codes.check('b1', 'Steve', second, false)).toEqual({ kind: 'none' });
		expect(codes.check('b1', 'Alex', other, false)).toEqual({ kind: 'right', userId: 'u1' });
		// After voiding, a new code starts the count again.
		const fresh = codes.issue('b1', 'Steve', 'u1');
		expect(codes.check('b1', 'Steve', fresh === wrong ? '555555' : wrong, false)).toEqual({
			kind: 'wrong',
			voided: false,
		});
	});

	it("doesn't count a code for a name with none given", () => {
		const codes = new LinkCodes(now);
		for (let i = 0; i < MAX_WRONG_TRIES + 1; i++) {
			expect(codes.check('b1', 'Steve', '123456', false)).toEqual({ kind: 'none' });
		}
		const code = codes.issue('b1', 'Steve', 'u1');
		expect(codes.check('b1', 'Steve', code, false)).toEqual({ kind: 'right', userId: 'u1' });
	});
});

describe('readLinkReport', () => {
	const report = { player: 'Steve_2', code: '012345', uuid: MOJANG_UUID, onlineMode: true };

	it('reads a report, with or without a UUID', () => {
		expect(readLinkReport(report)).toEqual(report);
		expect(readLinkReport({ ...report, uuid: undefined })).toEqual({
			player: 'Steve_2',
			code: '012345',
			onlineMode: true,
		});
		expect(readLinkReport({ ...report, uuid: null })).toEqual({ player: 'Steve_2', code: '012345', onlineMode: true });
	});

	it('reads a UUID in capitals as the log writes it, lowercase', () => {
		expect(readLinkReport({ ...report, uuid: MOJANG_UUID.toUpperCase() })).toEqual(report);
	});

	it.each([
		['a UUID without dashes', { ...report, uuid: MOJANG_UUID.replaceAll('-', '') }],
		['a UUID that is not one', { ...report, uuid: 'Steve' }],
		['no object', null],
		['a list', [report]],
		['a name Minecraft refuses', { ...report, player: 'Steve Two' }],
		['a long name', { ...report, player: 'a'.repeat(17) }],
		['a short code', { ...report, code: '12345' }],
		['a code with more', { ...report, code: '123456 ' }],
		['a number for a code', { ...report, code: 123456 }],
		['no online-mode', { ...report, onlineMode: undefined }],
		['a UUID that is no string', { ...report, uuid: 5 }],
	])('refuses %s', (_, message) => {
		expect(readLinkReport(message)).toBeNull();
	});
});

describe('answerLinkReport', () => {
	it('links the player as the log names them to the member given the code, and uses the code up', () => {
		const codes = new LinkCodes(now);
		const id = bridge();
		const code = codes.issue(id, 'steve', 'u1');

		expect(answerLinkReport(codes, id, { player: 'Steve', code, uuid: MOJANG_UUID, onlineMode: true }, time)).toEqual({
			result: 'linked',
			text: 'Linked Steve to your Discord account. Choose your picture in the dashboard.',
		});
		expect(getLink(id, 'steve')).toMatchObject({ name: 'Steve', user_id: 'u1', uuid: MOJANG_UUID, linked_at: time });
		expect(codes.check(id, 'Steve', code, false)).toEqual({ kind: 'none' });
	});

	it("replaces another member's link to the name, and their picture with it", () => {
		const codes = new LinkCodes(now);
		const id = bridge();
		saveLink({ bridgeId: id, name: 'Steve', userId: 'u1', uuid: MOJANG_UUID, now: time });
		setLinkPicture(id, 'Steve', 'u1', 'skin');
		const code = codes.issue(id, 'Steve', 'u2');

		answerLinkReport(codes, id, { player: 'Steve', code, uuid: MOJANG_UUID, onlineMode: true }, time);

		expect(getBridgeLinks(id)).toEqual([expect.objectContaining({ user_id: 'u2', picture: 'default' })]);
	});

	it('refuses an offline-mode server before looking at the code, leaving it to be used', () => {
		const codes = new LinkCodes(now);
		const id = bridge();
		const code = codes.issue(id, 'Steve', 'u1');

		expect(answerLinkReport(codes, id, { player: 'Steve', code, uuid: MOJANG_UUID, onlineMode: false }, time)).toEqual({
			result: 'offline-mode',
			text: "This server is in offline mode, so its players can't link a Discord account.",
		});
		for (let i = 0; i < MAX_WRONG_TRIES; i++) {
			answerLinkReport(codes, id, { player: 'Steve', code: 'x', uuid: MOJANG_UUID, onlineMode: false }, time);
		}
		expect(codes.check(id, 'Steve', code, false)).toEqual({ kind: 'right', userId: 'u1' });
		expect(getBridgeLinks(id)).toEqual([]);
	});

	it('says when no code was given for the name', () => {
		const codes = new LinkCodes(now);
		const id = bridge();

		expect(
			answerLinkReport(codes, id, { player: 'Steve', code: '123456', uuid: MOJANG_UUID, onlineMode: true }, time),
		).toEqual({
			result: 'no-code',
			text: "There's no link code waiting for Steve. Get one in the dashboard, then type it here.",
		});
	});

	it('says when the code is wrong, then when the codes are voided', () => {
		const codes = new LinkCodes(now);
		const id = bridge();
		nextRandom.push(111111);
		codes.issue(id, 'Steve', 'u1');
		const wrong = { player: 'Steve', code: '222222', uuid: MOJANG_UUID, onlineMode: true };

		for (let i = 1; i < MAX_WRONG_TRIES; i++) {
			expect(answerLinkReport(codes, id, wrong, time)).toEqual({
				result: 'wrong-code',
				text: "That isn't the code given for Steve. Check it, or get a new one.",
			});
		}
		expect(answerLinkReport(codes, id, wrong, time)).toEqual({
			result: 'voided',
			text: 'Too many wrong codes for Steve, so its codes no longer work. Get a new one.',
		});
		expect(answerLinkReport(codes, id, { ...wrong, code: '111111' }, time).result).toBe('no-code');
		expect(getBridgeLinks(id)).toEqual([]);
	});

	it('asks a player whose login the helper missed to log in again, keeping the code for after', () => {
		const codes = new LinkCodes(now);
		const id = bridge();
		const code = codes.issue(id, 'Steve', 'u1');

		expect(answerLinkReport(codes, id, { player: 'Steve', code, onlineMode: true }, time)).toEqual({
			result: 'log-in-again',
			text: 'Log out and back in, then type the code again.',
		});
		expect(getBridgeLinks(id)).toEqual([]);
		expect(
			answerLinkReport(codes, id, { player: 'Steve', code, uuid: MOJANG_UUID, onlineMode: true }, time).result,
		).toBe('linked');
	});

	it("refuses a UUID that isn't Mojang's, keeping the code", () => {
		const codes = new LinkCodes(now);
		const id = bridge();
		const code = codes.issue(id, 'Steve', 'u1');

		expect(answerLinkReport(codes, id, { player: 'Steve', code, uuid: OFFLINE_UUID, onlineMode: true }, time)).toEqual({
			result: 'not-mojang',
			text: "This server didn't give your account's Mojang UUID, so it can't be linked.",
		});
		expect(getBridgeLinks(id)).toEqual([]);
		expect(codes.check(id, 'Steve', code, false)).toEqual({ kind: 'right', userId: 'u1' });
	});
});
