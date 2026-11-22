// What mcbridge reads from the Minecraft server's own server.properties: RCON's
// settings, for two-way chat, and online-mode, for linking. Defaults and the
// encoding from minecraft.wiki's Server.properties page (checked 2026-11-22).

/**
 * The file's text as the server reads it: UTF-8, or ISO-8859-1 when it isn't
 * valid UTF-8 (a file written by an old version).
 */
export function decodeServerProperties(bytes: Uint8Array): string {
	try {
		// A BOM is kept, as Java's decoder keeps it: the server would read it as
		// part of the first key.
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		// Not TextDecoder('latin1'), which is windows-1252 and differs from
		// ISO-8859-1 in 0x80 to 0x9f.
		return Buffer.from(bytes).toString('latin1');
	}
}

const WHITESPACE = new Set([' ', '\t', '\f']);
const ESCAPED: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' };

function stripIndent(line: string): string {
	return line.replace(/^[ \t\f]+/, '');
}

function endsInEscapedLineBreak(line: string): boolean {
	let backslashes = 0;
	for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
	return backslashes % 2 === 1;
}

function unescape(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char !== '\\') {
			out += char;
			continue;
		}
		const next = text[++i];
		if (next === 'u') {
			const hex = text.slice(i + 1, i + 5);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError(`Malformed \\uXXXX escape: \\u${hex}`);
			out += String.fromCharCode(parseInt(hex, 16));
			i += 4;
		} else if (next !== undefined) {
			out += ESCAPED[next] ?? next;
		}
	}
	return out;
}

/**
 * A Java properties file's keys and values, read the way
 * `java.util.Properties.load` reads them: `#` and `!` comments, keys ending
 * at an unescaped `=`, `:` or whitespace, a trailing `\` continuing the line,
 * and the escapes `\t`, `\n`, `\r`, `\f`, `\uXXXX` and `\` before any other
 * character. A later key replaces an earlier one. Throws a SyntaxError for a
 * malformed `\u` escape, as Java does.
 */
export function parseProperties(text: string): Map<string, string> {
	const lines = text.split(/\r\n|\r|\n/);
	const properties = new Map<string, string>();
	for (let i = 0; i < lines.length; i++) {
		let line = stripIndent(lines[i] ?? '');
		if (line === '' || line[0] === '#' || line[0] === '!') continue;
		while (endsInEscapedLineBreak(line)) {
			line = line.slice(0, -1);
			if (++i >= lines.length) break;
			line += stripIndent(lines[i] ?? '');
		}

		let keyEnd = 0;
		let separated = false;
		while (keyEnd < line.length) {
			const char = line.charAt(keyEnd);
			if (char === '\\') keyEnd += 2;
			else if (char === '=' || char === ':') {
				separated = true;
				break;
			} else if (WHITESPACE.has(char)) break;
			else keyEnd++;
		}
		keyEnd = Math.min(keyEnd, line.length);
		let valueStart = keyEnd + 1;
		while (valueStart < line.length) {
			const char = line.charAt(valueStart);
			if (WHITESPACE.has(char)) valueStart++;
			else if (!separated && (char === '=' || char === ':')) {
				separated = true;
				valueStart++;
			} else break;
		}
		properties.set(unescape(line.slice(0, keyEnd)), unescape(line.slice(valueStart)));
	}
	return properties;
}

export const DEFAULT_RCON_PORT = 25575;

export type RconSettings =
	{ enabled: true; port: number; password: string } | { enabled: false; reason: RconOffReason };

/**
 * Why RCON is off: `enable-rcon` isn't true, the password is empty (the
 * server then doesn't start RCON), or `rcon.port` is a number no TCP port can be.
 */
export type RconOffReason = 'disabled' | 'no-password' | 'bad-port';

export interface ServerSettings {
	rcon: RconSettings;
	onlineMode: boolean;
}

// A missing key is the server's default. A present one is true only if it
// reads `true` in any case, as Java's Boolean.valueOf (the server's parser,
// from review, recalled and not checked; A8h checks it). That is also the
// safe side for linking: an unclear online-mode reads as offline.
function booleanOr(value: string | undefined, fallback: boolean): boolean {
	return value === undefined ? fallback : value.toLowerCase() === 'true';
}

// Something that isn't a whole number is set to the default (the wiki). A
// number outside TCP's range is reported instead: the server's handling of
// it isn't documented, and guessing would send mcbridge to the wrong port.
function readPort(value: string | undefined): number | null {
	if (value === undefined || !/^[+-]?\d+$/.test(value)) return DEFAULT_RCON_PORT;
	const port = Number(value);
	return port >= 1 && port <= 65535 ? port : null;
}

export function serverSettings(properties: Map<string, string>): ServerSettings {
	const onlineMode = booleanOr(properties.get('online-mode'), true);
	const off = (reason: RconOffReason): ServerSettings => ({ rcon: { enabled: false, reason }, onlineMode });
	if (!booleanOr(properties.get('enable-rcon'), false)) return off('disabled');
	const password = properties.get('rcon.password') ?? '';
	if (password === '') return off('no-password');
	const port = readPort(properties.get('rcon.port'));
	if (port === null) return off('bad-port');
	return { rcon: { enabled: true, port, password }, onlineMode };
}
