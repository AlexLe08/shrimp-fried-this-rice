import { describe, expect, it } from 'vitest';
import {
	decodeServerProperties,
	DEFAULT_RCON_PORT,
	parseProperties,
	serverSettings,
} from '../../../src/minecraft/bridge/serverProperties.ts';

const settings = (text: string) => serverSettings(parseProperties(text));

describe('parseProperties', () => {
	it('reads a file as the server writes it, skipping comments', () => {
		const text = [
			'#Minecraft server properties',
			'#Sun Nov 22 12:00:00 EST 2026',
			'enable-rcon=true',
			'motd=A Minecraft Server',
			'rcon.password=',
			'rcon.port=25575',
		].join('\n');
		expect(Object.fromEntries(parseProperties(text))).toEqual({
			'enable-rcon': 'true',
			motd: 'A Minecraft Server',
			'rcon.password': '',
			'rcon.port': '25575',
		});
	});

	it('takes =, : or whitespace as the separator, with whitespace around it', () => {
		const properties = parseProperties('a=1\nb:2\nc 3\nd = 4\ne\t:\t5\nf  =  = 6\ng\n');
		expect(Object.fromEntries(properties)).toEqual({ a: '1', b: '2', c: '3', d: '4', e: '5', f: '= 6', g: '' });
	});

	it("keeps a value's trailing whitespace and inner separators", () => {
		expect(parseProperties('rcon.password=a=b:c d  ').get('rcon.password')).toBe('a=b:c d  ');
	});

	it('skips blank lines, leading whitespace, and ! comments', () => {
		expect(Object.fromEntries(parseProperties('\n   \n  ! note\n\t# note\n  \f key=value\n'))).toEqual({
			key: 'value',
		});
	});

	it('decodes escapes in keys and values', () => {
		const properties = parseProperties('rcon.password=p\\=a\\:s\\ s\\\\w\\u00f6rd\\t\\q\nmy\\ key\\:x=1');
		expect(properties.get('rcon.password')).toBe('p=a:s s\\wörd\tq');
		expect(properties.get('my key:x')).toBe('1');
	});

	it('joins a line ending in an odd number of backslashes with the next, without its leading whitespace', () => {
		const properties = parseProperties('motd=one \\\n    two\\\n\nkey=a\\\\\nother=b');
		expect(properties.get('motd')).toBe('one two');
		expect(properties.get('key')).toBe('a\\');
		expect(properties.get('other')).toBe('b');
	});

	it('does not continue a comment, and treats a continued line starting with # as text', () => {
		const properties = parseProperties('# comment \\\nkey=a\\\n# not a comment');
		expect(properties.get('key')).toBe('a# not a comment');
	});

	it('reads \\r\\n and \\r line endings, and lets a later key win', () => {
		expect(Object.fromEntries(parseProperties('a=1\r\nb=2\ra=3'))).toEqual({ a: '3', b: '2' });
	});

	it('refuses a malformed \\u escape, as Java does', () => {
		expect(() => parseProperties('rcon.password=\\u12g4')).toThrow(SyntaxError);
		expect(() => parseProperties('rcon.password=\\u12')).toThrow(SyntaxError);
	});

	it('ignores a lone backslash at the end of the file', () => {
		expect(parseProperties('key=value\\').get('key')).toBe('value');
	});
});

describe('decodeServerProperties', () => {
	it('reads UTF-8', () => {
		expect(decodeServerProperties(new TextEncoder().encode('rcon.password=wörd😀'))).toBe('rcon.password=wörd😀');
	});

	it('falls back to ISO-8859-1 (not windows-1252) when the bytes are not UTF-8', () => {
		const bytes = Uint8Array.from([0x70, 0x3d, 0xf6, 0x80]);
		expect(decodeServerProperties(bytes)).toBe('p=ö\u0080');
	});
});

describe('serverSettings', () => {
	it('gives the port and password when RCON is on', () => {
		expect(settings('enable-rcon=true\nrcon.port=25580\nrcon.password=secret\nonline-mode=false')).toEqual({
			rcon: { enabled: true, port: 25580, password: 'secret' },
			onlineMode: false,
		});
	});

	it("uses the server's defaults for missing keys: RCON off, online mode on", () => {
		expect(settings('')).toEqual({ rcon: { enabled: false, reason: 'disabled' }, onlineMode: true });
		expect(settings('enable-rcon=true\nrcon.password=x').rcon).toEqual({
			enabled: true,
			port: DEFAULT_RCON_PORT,
			password: 'x',
		});
	});

	it('says RCON is off with a blank password, as the server then does not start it', () => {
		expect(settings('enable-rcon=true\nrcon.password=').rcon).toEqual({ enabled: false, reason: 'no-password' });
		expect(settings('enable-rcon=true').rcon).toEqual({ enabled: false, reason: 'no-password' });
	});

	it('reads a boolean as true only when it says true, in any case, as the server does', () => {
		expect(settings('enable-rcon=TRUE\nrcon.password=x').rcon.enabled).toBe(true);
		expect(settings('enable-rcon=yes\nrcon.password=x').rcon).toEqual({ enabled: false, reason: 'disabled' });
		// Linking needs online mode, so anything unclear must read as offline.
		expect(settings('online-mode=nope').onlineMode).toBe(false);
		expect(settings('online-mode=false ').onlineMode).toBe(false);
		expect(settings('online-mode=true ').onlineMode).toBe(false);
		expect(settings('online-mode=').onlineMode).toBe(false);
	});

	it('reads a port that is not a whole number as the default', () => {
		for (const port of ['', 'abc', '25575.5', '2557 5']) {
			const rcon = settings(`enable-rcon=true\nrcon.password=x\nrcon.port=${port}`).rcon;
			expect(rcon, port).toEqual({ enabled: true, port: DEFAULT_RCON_PORT, password: 'x' });
		}
		expect(settings('enable-rcon=true\nrcon.password=x\nrcon.port=+1').rcon).toMatchObject({ port: 1 });
		expect(settings('enable-rcon=true\nrcon.password=x\nrcon.port=65535').rcon).toMatchObject({ port: 65535 });
	});

	it('says RCON is off for a port no TCP port can be, rather than guessing', () => {
		for (const port of ['0', '-1', '65536', '99999999999']) {
			const rcon = settings(`enable-rcon=true\nrcon.password=x\nrcon.port=${port}`).rcon;
			expect(rcon, port).toEqual({ enabled: false, reason: 'bad-port' });
		}
	});
});
