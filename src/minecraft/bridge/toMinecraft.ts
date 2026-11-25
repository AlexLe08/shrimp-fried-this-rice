import { MAX_COMMAND_BYTES } from './rcon.ts';

/** How a Discord message is marked in game: `[Discord] Name: text`, the prefix in its colour. */
export interface ChatStyle {
	prefix: string;
	/** One of Minecraft's 16 named colours, or `#rrggbb`. */
	colour: string;
}

// The owner's defaults (2026-11-21): Discord's blurple.
export const DEFAULT_STYLE: ChatStyle = { prefix: '[Discord]', colour: '#5865F2' };

// minecraft.wiki's Text component format, checked 2026-11-22.
const NAMED_COLOURS = new Set([
	'black',
	'dark_blue',
	'dark_green',
	'dark_aqua',
	'dark_red',
	'dark_purple',
	'gold',
	'gray',
	'dark_gray',
	'blue',
	'green',
	'aqua',
	'red',
	'light_purple',
	'yellow',
	'white',
]);
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

export function isColour(colour: string): boolean {
	return NAMED_COLOURS.has(colour) || HEX_COLOUR.test(colour);
}

// If the server logs tellraw output without `System chat: `, the line starts
// with the prefix. So it can't contain `<` or `>`, can't start with a
// character a player name can, and can't start with `[Not Secure]`: then no
// relayed line can read back from the log as a player's chat or a join.
const PREFIX = /^[[\](){}\-.:|*#!~][A-Za-z0-9 [\](){}\-.:|*#!~]{0,23}$/;

export function isPrefix(prefix: string): boolean {
	return PREFIX.test(prefix) && !prefix.startsWith('[Not Secure]');
}

/**
 * Text as one chat line: line breaks become spaces, and `§` (formatting
 * codes, which the wiki says both are and aren't applied in a component's
 * text), control characters and bidi controls are removed. A bidi override
 * would let a Discord user reorder how their line reads in game.
 */
export function cleanText(text: string): string {
	return text
		.replace(/\r\n|[\r\n\t\u2028\u2029]/g, ' ')
		.replace(/[\p{Cc}§\u202a-\u202e\u2066-\u2069]/gu, '')
		.trim();
}

// JSON.stringify quotes and escapes everything a Discord user typed, so they
// can't end the string and add a command; JSON-style components are valid
// SNBT. RCON commands go out as ASCII, so every other character (each UTF-16
// unit, so an emoji is its surrogate pair) becomes a `\uXXXX` escape, which
// SNBT strings accept since 1.21.5.
function toSnbt(value: unknown): string {
	return JSON.stringify(value).replace(
		/[^\x20-\x7e]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);
}

function tellraw(target: string, style: ChatStyle, label: string, text: string): string {
	// Every list element a compound: the wiki allows mixed lists but contradicts
	// itself on how they're converted.
	const component = {
		text: '',
		extra: [{ text: style.prefix, color: style.colour.toLowerCase() }, { text: label }, { text, color: 'white' }],
	};
	return `tellraw ${target} ${toSnbt(component)}`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function checkStyle(style: ChatStyle): void {
	if (!isPrefix(style.prefix)) throw new TypeError(`Not a valid prefix: ${JSON.stringify(style.prefix)}`);
	if (!isColour(style.colour)) throw new TypeError(`Not a valid colour: ${JSON.stringify(style.colour)}`);
}

// The command with as much of the text as fits RCON's limit, cut with `…`
// (never inside a character or an emoji); null when not even `…` fits.
function fitted(build: (text: string) => string, body: string): string | null {
	const whole = build(body);
	if (whole.length <= MAX_COMMAND_BYTES) return whole;

	const parts = Array.from(graphemes.segment(body), (part) => part.segment);
	const cut = (count: number) => build(`${parts.slice(0, count).join('').trimEnd()}…`);
	if (cut(0).length > MAX_COMMAND_BYTES) return null;
	// The largest count that fits: the command only grows with it.
	let fits = 0;
	let tooLong = parts.length;
	while (tooLong - fits > 1) {
		const middle = Math.floor((fits + tooLong) / 2);
		if (cut(middle).length <= MAX_COMMAND_BYTES) fits = middle;
		else tooLong = middle;
	}
	return cut(fits);
}

/**
 * The `tellraw @a` command showing a Discord message in game, cut with `…`
 * to fit RCON's command limit (never inside a character or an emoji). Null
 * when nothing is left of the text to show.
 *
 * Throws for a style the dashboard wouldn't accept, or a sender name so long
 * the command can't fit any text (a Discord nickname is at most 32
 * characters, which always fits).
 */
export function chatCommand(sender: string, text: string, style: ChatStyle = DEFAULT_STYLE): string | null {
	checkStyle(style);
	// A nickname of nothing but `§` is possible in Discord.
	const name = cleanText(sender) || '?';
	const body = cleanText(text);
	if (!body) return null;
	const command = fitted((cut) => tellraw('@a', style, ` ${name}: `, cut), body);
	if (!command) throw new RangeError(`A sender name of ${name.length} characters leaves no room`);
	return command;
}

// Minecraft's rule for a name, as settings.ts's isPlayerName (which imports
// this file): nothing that could end the target and start another argument.
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

/**
 * The `tellraw <player>` command showing that player alone the bot's answer
 * to their `!link` line, marked with the prefix as chat from Discord is, and
 * cut to fit like it. Null when nothing is left of the text to show. Throws
 * for a name that isn't a player's, or a style the dashboard wouldn't accept.
 */
export function privateCommand(player: string, text: string, style: ChatStyle = DEFAULT_STYLE): string | null {
	if (!PLAYER_NAME.test(player)) throw new TypeError(`Not a player name: ${JSON.stringify(player)}`);
	checkStyle(style);
	const body = cleanText(text);
	if (!body) return null;
	// A name of 16 and the longest prefix leave over a thousand bytes for the text.
	return fitted((cut) => tellraw(player, style, ' ', cut), body);
}
