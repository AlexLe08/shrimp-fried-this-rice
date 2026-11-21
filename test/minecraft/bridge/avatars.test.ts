import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	avatarFor,
	DEFAULT_AVATARS,
	GENERATED_AVATARS,
	hashName,
	parseAvatars,
	type AvatarConfig,
} from '../../../src/minecraft/bridge/avatars.ts';

const GENERATED = 'https://raw.githubusercontent.com/AlexLe08/shrimp-fried-this-rice/main/assets/mcbridge-avatars/';
const ONLINE_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
// Offline mode's UUID for "Steve": a name-based (version 3) UUID.
const OFFLINE_UUID = '5627dd98-e6be-3c21-b8a8-e92344183641';

function parsed(raw: unknown): { avatars: AvatarConfig; problems: string[] } {
	const problems: string[] = [];
	return { avatars: parseAvatars(raw, problems), problems };
}

const config = (raw: unknown) => {
	const { avatars, problems } = parsed(raw);
	expect(problems).toEqual([]);
	return avatars;
};

describe('hashName', () => {
	it('ignores case and stays within the bundled pictures', () => {
		expect(hashName('STEVE')).toBe(hashName('steve'));
		for (let i = 0; i < 500; i++) {
			const index = hashName(`player${i}`);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(GENERATED_AVATARS);
		}
	});

	it('has a bundled PNG for every picture it can pick, and no others', () => {
		const folder = join(import.meta.dirname, '../../../assets/mcbridge-avatars');
		const expected = Array.from({ length: GENERATED_AVATARS }, (_, i) => `${i}.png`);
		expect(readdirSync(folder).sort()).toEqual(expected.sort());
		for (const file of expected) {
			expect(readFileSync(join(folder, file)).subarray(1, 4).toString('ascii')).toBe('PNG');
		}
	});

	it('spreads names over every picture', () => {
		const used = new Set(Array.from({ length: 200 }, (_, i) => hashName(`p${i}`)));
		expect(used.size).toBe(GENERATED_AVATARS);
	});

	it('gives the same pictures as before', () => {
		// Pinned: a change to the hash moves every hashed player to another picture.
		expect(['Steve', 'Alex', 'Notch', 'jeb_'].map(hashName)).toMatchInlineSnapshot(`
			[
			  0,
			  1,
			  7,
			  7,
			]
		`);
	});
});

describe('avatarFor', () => {
	it('gives a generated picture by default, picked from the name', () => {
		expect(avatarFor('Steve', DEFAULT_AVATARS)).toBe(`${GENERATED}${hashName('Steve')}.png`);
		expect(avatarFor('steve', DEFAULT_AVATARS)).toBe(avatarFor('Steve', DEFAULT_AVATARS));
	});

	it('looks a skin up by UUID, without dashes, when the log gave one', () => {
		const avatars = config({ default: 'skin' });
		expect(avatarFor('Notch', avatars, ONLINE_UUID)).toBe(
			'https://mc-heads.net/avatar/069a79f444e94726a5befca90e38aaf5/128',
		);
		expect(avatarFor('Notch', avatars, ONLINE_UUID.toUpperCase())).toBe(
			'https://mc-heads.net/avatar/069a79f444e94726a5befca90e38aaf5/128',
		);
	});

	it('looks a skin up by name when no UUID was seen', () => {
		expect(avatarFor('Notch', config({ default: 'skin' }))).toBe('https://mc-heads.net/avatar/Notch/128');
	});

	it("gives an offline-mode player a generated picture, not a stranger's skin", () => {
		expect(avatarFor('Steve', config({ default: 'skin' }), OFFLINE_UUID)).toBe(`${GENERATED}${hashName('Steve')}.png`);
	});

	it("uses a player's own entry over the default, whatever the case", () => {
		const avatars = config({
			default: 'none',
			players: {
				steve: 'skin',
				Alex: 'generated',
				Herobrine: 'generated:7',
				Notch: 'https://example.com/notch.png',
			},
		});
		expect(avatarFor('Steve', avatars, ONLINE_UUID)).toBe(
			'https://mc-heads.net/avatar/069a79f444e94726a5befca90e38aaf5/128',
		);
		expect(avatarFor('Alex', avatars)).toBe(`${GENERATED}${hashName('Alex')}.png`);
		expect(avatarFor('HEROBRINE', avatars)).toBe(`${GENERATED}7.png`);
		expect(avatarFor('Notch', avatars)).toBe('https://example.com/notch.png');
		expect(avatarFor('jeb_', avatars)).toBeUndefined();
	});
});

describe('parseAvatars', () => {
	it('defaults to generated pictures without the key', () => {
		expect(parsed(undefined)).toEqual({ avatars: DEFAULT_AVATARS, problems: [] });
		expect(config({}).default).toEqual({ kind: 'generated' });
	});

	it('accepts every kind of entry', () => {
		const avatars = config({
			default: 'skin',
			players: { A: 'skin', B: 'generated', C: 'generated:0', D: 'generated:9', E: 'none', F: 'https://x.test/f.png' },
		});
		expect(avatars.default).toEqual({ kind: 'skin' });
		expect(Object.fromEntries(avatars.players)).toEqual({
			a: { kind: 'skin' },
			b: { kind: 'generated' },
			c: { kind: 'generated', index: 0 },
			d: { kind: 'generated', index: 9 },
			e: { kind: 'none' },
			f: { kind: 'url', url: 'https://x.test/f.png' },
		});
	});

	it('reports every problem', () => {
		expect(
			parsed({
				default: 'generated:3',
				players: {
					'not a name': 'skin',
					Steve: 'skin',
					steve: 'none',
					Alex: 'generated:10',
					Notch: 'http://example.com/notch.png',
					jeb_: 'nope',
					Dinnerbone: 7,
				},
				extra: true,
			}).problems,
		).toEqual([
			'unknown key "avatars.extra"',
			'"avatars.default" must be "skin", "generated" or "none"',
			`"avatars.players.not a name" isn't a Minecraft name (letters, digits and _, up to 16)`,
			`"avatars.players.steve" is listed twice (names don't depend on case)`,
			'"avatars.players.Alex" must be "skin", "generated", "generated:0" to "generated:9", "none" or an https image URL',
			'"avatars.players.Notch" must be "skin", "generated", "generated:0" to "generated:9", "none" or an https image URL',
			'"avatars.players.jeb_" must be "skin", "generated", "generated:0" to "generated:9", "none" or an https image URL',
			'"avatars.players.Dinnerbone" must be "skin", "generated", "generated:0" to "generated:9", "none" or an https image URL',
		]);
	});

	it('refuses an avatars or players that is not an object', () => {
		expect(parsed('skin').problems).toEqual(['"avatars" must be an object with "default" and "players"']);
		expect(parsed({ players: ['Steve'] }).problems).toEqual(['"avatars.players" must be an object of player names']);
	});
});
