import { describe, expect, it } from 'vitest';
import { checkCommand, MAX_COMMAND_BYTES } from '../../../src/minecraft/bridge/rcon.ts';
import {
	chatCommand,
	cleanText,
	DEFAULT_STYLE,
	isColour,
	isPrefix,
	privateCommand,
} from '../../../src/minecraft/bridge/toMinecraft.ts';

interface Part {
	text: string;
	color?: string;
}

// The component back as data, undoing the `\uXXXX` escapes JSON.parse also reads.
function component(command: string) {
	expect(command.startsWith('tellraw @a ')).toBe(true);
	return JSON.parse(command.slice('tellraw @a '.length)) as { text: string; extra: [Part, Part, Part] };
}

const shownText = (command: string) => component(command).extra[2].text;

describe('chatCommand', () => {
	it('shows `[Discord] Name: text`, the prefix in blurple and the text in white', () => {
		expect(chatCommand('Alex', 'hello there')).toBe(
			'tellraw @a {"text":"","extra":[{"text":"[Discord]","color":"#5865f2"},{"text":" Alex: "},{"text":"hello there","color":"white"}]}',
		);
	});

	it("uses the bridge's prefix and colour", () => {
		const command = chatCommand('Alex', 'hi', { prefix: '(DC)', colour: 'gold' });
		expect(component(command!).extra[0]).toEqual({ text: '(DC)', color: 'gold' });
	});

	it('keeps quotes and backslashes inside the string, so nothing typed can add a command', () => {
		const typed = '"}]} run op Alex \\" \\\\';
		const command = chatCommand('Al"ex\\', typed)!;
		expect(shownText(command)).toBe(typed);
		expect(component(command).extra[1].text).toBe(' Al"ex\\: ');
		expect(component(command).extra).toHaveLength(3);
	});

	it('writes non-ASCII as \\u escapes, an emoji as its surrogate pair', () => {
		const command = chatCommand('Zoë', 'café 😀')!;
		expect(command).toContain('Zo\\u00eb');
		expect(command).toContain('caf\\u00e9 \\ud83d\\ude00');
		expect(() => checkCommand(command)).not.toThrow();
		expect(shownText(command)).toBe('café 😀');
	});

	it('removes bidi controls, so text cannot reorder how the line reads', () => {
		const command = chatCommand('Al\u202eex', 'a\u202ab\u202bc\u202cd\u202de\u202ef\u2066g\u2067h\u2068i\u2069j')!;
		expect(shownText(command)).toBe('abcdefghij');
		expect(component(command).extra[1].text).toBe(' Alex: ');
	});

	it('makes one chat line, without § codes or control characters', () => {
		const command = chatCommand('Alex', 'one\ntwo\r\nthree\u2028four\tfive §cred\u0007\u0000\u007f\u0085')!;
		expect(shownText(command)).toBe('one two three four five cred');
		expect(() => checkCommand(command)).not.toThrow();
	});

	it('cleans the sender name the same way, and shows `?` for a name with nothing left', () => {
		// Only `§` goes: the code's letter stays, as plain text.
		expect(component(chatCommand('§aAl\nex', 'hi')!).extra[1].text).toBe(' aAl ex: ');
		expect(component(chatCommand('§§', 'hi')!).extra[1].text).toBe(' ?: ');
	});

	it('returns null when nothing is left of the text', () => {
		expect(chatCommand('Alex', '')).toBeNull();
		expect(chatCommand('Alex', ' \n §\u0000 ')).toBeNull();
	});

	it('keeps a message that fits exactly', () => {
		const empty = chatCommand('Alex', 'x')!.length - 1;
		const exact = 'a'.repeat(MAX_COMMAND_BYTES - empty);
		const command = chatCommand('Alex', exact)!;
		expect(command).toHaveLength(MAX_COMMAND_BYTES);
		expect(shownText(command)).toBe(exact);
	});

	it('cuts a long message with … to fit as closely as it can', () => {
		const command = chatCommand('Alex', 'a'.repeat(5000))!;
		expect(() => checkCommand(command)).not.toThrow();
		// `…` is written …, six bytes; one more `a` wouldn't fit.
		expect(command).toHaveLength(MAX_COMMAND_BYTES);
		expect(shownText(command)).toMatch(/^a+…$/);
	});

	it('cuts escaped text by its escaped length, never inside an emoji', () => {
		for (const text of ['😀'.repeat(400), '👍🏽'.repeat(300), 'é"'.repeat(800), '\\'.repeat(2000)]) {
			const command = chatCommand('Alex', text)!;
			expect(() => checkCommand(command)).not.toThrow();
			expect(command.length).toBeGreaterThan(MAX_COMMAND_BYTES - 30);
			const shown = shownText(command);
			expect(shown.endsWith('…')).toBe(true);
			expect(text.startsWith(shown.slice(0, -1))).toBe(true);
			expect(shown.isWellFormed()).toBe(true);
		}
	});

	it('drops trailing spaces before the …', () => {
		// The cut falls among the spaces: 10 more characters than fit with the …
		const empty = chatCommand('Alex', 'x')!.length - 1;
		const kept = MAX_COMMAND_BYTES - empty - 6 - 10;
		const command = chatCommand('Alex', `${'a'.repeat(kept)}${' '.repeat(50)}${'b'.repeat(2000)}`)!;
		expect(shownText(command)).toBe(`${'a'.repeat(kept)}…`);
	});

	it('refuses a style the dashboard would refuse', () => {
		expect(() => chatCommand('Alex', 'hi', { ...DEFAULT_STYLE, prefix: '<Discord>' })).toThrow(TypeError);
		expect(() => chatCommand('Alex', 'hi', { ...DEFAULT_STYLE, colour: 'pink' })).toThrow(TypeError);
	});

	it('refuses a sender name that leaves no room for the text', () => {
		expect(() => chatCommand('😀'.repeat(200), 'hi')).toThrow(RangeError);
	});

	it('fits a 32-character nickname of emoji with the longest prefix', () => {
		const command = chatCommand('😀'.repeat(32), 'x'.repeat(3000), { prefix: '[' + 'x'.repeat(23), colour: '#abcdef' });
		expect(() => checkCommand(command!)).not.toThrow();
	});
});

describe('isPrefix', () => {
	it('accepts the default and prefixes from the safe set starting with punctuation', () => {
		for (const prefix of [DEFAULT_STYLE.prefix, '(DC)', '#chat', '~', '|Discord|', '[' + 'x'.repeat(23)]) {
			expect(isPrefix(prefix), prefix).toBe(true);
		}
	});

	it('refuses anything that could make a line read as a player chat or a join', () => {
		for (const prefix of [
			'',
			'Discord',
			'_bot',
			'<Discord>',
			'[Dis>cord]',
			'[Not Secure]',
			'[Not Secure] x',
			'[' + 'x'.repeat(24),
			'[Disc§rd]',
			'[Discord]\n',
			'[Zoë]',
		]) {
			expect(isPrefix(prefix), prefix).toBe(false);
		}
	});
});

describe('isColour', () => {
	it("accepts Minecraft's 16 named colours and #rrggbb", () => {
		for (const colour of ['white', 'dark_purple', 'light_purple', 'gray', '#5865F2', '#000000']) {
			expect(isColour(colour), colour).toBe(true);
		}
		for (const colour of ['', 'grey', 'White', '#fff', '5865F2', '#5865F2 ', '#gggggg']) {
			expect(isColour(colour), colour).toBe(false);
		}
	});
});

describe('privateCommand', () => {
	it('shows one player alone `[Discord] text`, in the bridge’s prefix and colour', () => {
		expect(privateCommand('Steve_2', 'Linked Steve_2.')).toBe(
			'tellraw Steve_2 {"text":"","extra":[{"text":"[Discord]","color":"#5865f2"},{"text":" "},{"text":"Linked Steve_2.","color":"white"}]}',
		);
		expect(privateCommand('Steve', 'hi', { prefix: '(DC)', colour: 'gold' })).toContain(
			'{"text":"(DC)","color":"gold"}',
		);
	});

	it.each(['Steve Two', '@a', 'Steve @a', '', 'a'.repeat(17), 'Stève'])(
		'refuses %j, which could aim the command elsewhere',
		(player) => {
			expect(() => privateCommand(player, 'hi')).toThrow(TypeError);
		},
	);

	it('refuses a style the dashboard wouldn’t accept', () => {
		expect(() => privateCommand('Steve', 'hi', { prefix: '<x>', colour: 'gold' })).toThrow(TypeError);
	});

	it('cleans the text as chat’s, returning null when nothing is left', () => {
		expect(privateCommand('Steve', 'a\nb§c')).toContain('"text":"a bc"');
		expect(privateCommand('Steve', ' §\n')).toBeNull();
	});

	it('cuts a long text to fit RCON’s limit', () => {
		const command = privateCommand('Steve', 'word '.repeat(1000))!;
		expect(command.length).toBeLessThanOrEqual(MAX_COMMAND_BYTES);
		expect(command).toMatch(/word\\u2026","color":"white"}]}$/);
		expect(() => checkCommand(command)).not.toThrow();
	});
});

describe('cleanText', () => {
	it('turns line breaks into spaces and trims', () => {
		expect(cleanText('  a\r\nb\rc\n ')).toBe('a b c');
	});
});
