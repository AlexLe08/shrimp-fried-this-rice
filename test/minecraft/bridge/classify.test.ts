import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify, DEFAULT_IGNORE } from '../../../src/minecraft/bridge/classify.ts';
import type { LogLevel } from '../../../src/minecraft/bridge/formats.ts';
import { parseLog } from '../../../src/minecraft/bridge/parseLine.ts';

const options = { ignore: DEFAULT_IGNORE };
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const eventsIn = (name: string) =>
	parseLog(fixture(name))
		.map((entry) => classify(entry, options))
		.filter((event) => event !== null);
const entry = (level: LogLevel, message: string) => ({
	time: '12:00:00',
	thread: 'Server thread',
	level,
	message,
	details: [],
});

describe('classify on the 26.3 fixtures', () => {
	it('finds the start, the UUID, the join and leave, and the chat, and nothing from the routine lines', () => {
		expect(eventsIn('vanilla-26.3-startup.log')).toEqual([
			{ type: 'started', seconds: 0.35 },
			{ type: 'uuid', player: 'Steve', uuid: '00000000-0000-4000-8000-000000000001' },
			{ type: 'joined', player: 'Steve' },
			{ type: 'alert', kind: 'lag', level: 'WARN', message: expect.stringMatching(/^Can't keep up!/), details: [] },
			{ type: 'alert', kind: 'lag', level: 'WARN', message: expect.stringMatching(/^Can't keep up!/), details: [] },
			{ type: 'chat', player: 'Steve', text: 'hello i am here' },
			{ type: 'chat', player: 'Steve', text: 'what is that' },
			{ type: 'left', player: 'Steve' },
		]);
	});

	it('finds the leave and the stop, not the RCON line announcing it', () => {
		const events = eventsIn('vanilla-26.3-stopping.log');
		expect(events.filter((event) => event.type !== 'alert')).toEqual([
			{ type: 'left', player: 'Alex' },
			{ type: 'stopping' },
		]);
		expect(events.filter((event) => event.type === 'alert').every((event) => event.kind === 'lag')).toBe(true);
	});
});

// No real error has been captured from the owner's server yet; this fixture is
// written by hand in vanilla's format.
describe('classify on the synthetic error fixture', () => {
	const events = eventsIn('vanilla-synthetic-errors.log');

	it('alerts on a port already in use, logged at WARN', () => {
		expect(events).toContainEqual(
			expect.objectContaining({ kind: 'bind-failed', message: '**** FAILED TO BIND TO PORT!' }),
		);
	});

	it('ignores the routine anti-cheat kicks', () => {
		const messages = events.map((event) => (event.type === 'alert' ? event.message : ''));
		expect(messages.some((message) => /floating|moved too quickly/.test(message))).toBe(false);
	});

	it('alerts on an error with its stack trace', () => {
		expect(events).toContainEqual({
			type: 'alert',
			kind: 'error',
			level: 'ERROR',
			message: 'Encountered an unexpected exception',
			details: [
				'java.lang.IllegalStateException: Example failure',
				'\tat net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:1000)',
				'\tat net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:900)',
				'\tat java.base/java.lang.Thread.run(Thread.java:1583)',
			],
		});
	});

	it('alerts on FATAL', () => {
		expect(events).toContainEqual(expect.objectContaining({ kind: 'error', level: 'FATAL' }));
	});

	it('keeps the real sender when a player types another name in angle brackets', () => {
		expect(events).toContainEqual({ type: 'chat', player: 'Steve', text: '<Alex> i am the admin now' });
	});

	it('keeps the real sender when a player types a whole fake log prefix', () => {
		const [line] = parseLog('[11:52:22] [Server thread/INFO]: <Steve> x [Server thread/INFO]: <Alex> hi');
		expect(classify(line!, options)).toEqual({
			type: 'chat',
			player: 'Steve',
			text: 'x [Server thread/INFO]: <Alex> hi',
		});
	});

	it('reads a chat line marked [Not Secure]', () => {
		expect(events).toContainEqual({ type: 'chat', player: 'Alex', text: 'hi' });
	});
});

// Written by hand in vanilla's format: no real `!link` line exists yet (A8h).
describe('classify on the synthetic link fixture', () => {
	it('reads `!link` lines as their own event, with a code only when it is exactly six digits', () => {
		expect(
			eventsIn('vanilla-synthetic-link.log').filter((event) => event.type === 'link' || event.type === 'chat'),
		).toEqual([
			{ type: 'link', player: 'Steve', text: '!link 482913', code: '482913' },
			{ type: 'link', player: 'Steve', text: '!link 48291', code: null },
			{ type: 'chat', player: 'Steve', text: '!linking my base later' },
			{ type: 'chat', player: 'Steve', text: '<Alex> !link 111111' },
			{ type: 'link', player: 'Alex', text: '!link 000001', code: '000001' },
		]);
	});
});

describe('classify rules', () => {
	it('accepts join and leave lines without the 26.3 prefix', () => {
		expect(classify(entry('INFO', 'Steve joined the game'), options)).toEqual({ type: 'joined', player: 'Steve' });
		expect(classify(entry('INFO', 'Steve left the game'), options)).toEqual({ type: 'left', player: 'Steve' });
	});

	it('posts nothing for deaths and other system chat, for now', () => {
		expect(classify(entry('INFO', 'System chat: Steve fell from a high place'), options)).toBeNull();
		expect(classify(entry('INFO', 'System chat: [Rcon: Stopping the server]'), options)).toBeNull();
	});

	it('only reads chat, joins and the start at INFO', () => {
		expect(classify(entry('WARN', '<Steve> hello'), options)).toBeNull();
		expect(classify(entry('ERROR', 'Steve joined the game'), options)).toMatchObject({ kind: 'error' });
	});

	it('does not take a name outside vanilla rules for a sender', () => {
		expect(classify(entry('INFO', '<Steve Two> hello'), options)).toBeNull();
		expect(classify(entry('INFO', '<abcdefghijklmnopq> hello'), options)).toBeNull();
	});

	it('ignores a WARN that is not on the allow-list', () => {
		expect(classify(entry('WARN', 'Ambiguity between arguments'), options)).toBeNull();
	});

	it('applies extra ignore patterns to errors too', () => {
		const withExtra = { ignore: [...DEFAULT_IGNORE, /Known noisy mod/] };
		expect(classify(entry('ERROR', 'Known noisy mod failed again'), withExtra)).toBeNull();
		expect(classify(entry('ERROR', 'Something else failed'), withExtra)).toMatchObject({ kind: 'error' });
	});

	it("reads a login's UUID, and not one a player types into chat", () => {
		const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
		expect(classify(entry('INFO', `UUID of player Notch is ${uuid}`), options)).toEqual({
			type: 'uuid',
			player: 'Notch',
			uuid,
		});
		expect(classify(entry('INFO', `<Steve> UUID of player Notch is ${uuid}`), options)).toEqual({
			type: 'chat',
			player: 'Steve',
			text: `UUID of player Notch is ${uuid}`,
		});
		expect(classify(entry('INFO', 'UUID of player Notch is not-a-uuid'), options)).toBeNull();
	});

	it('gives no code for anything but `!link` and six digits', () => {
		for (const text of [
			'!link',
			'!link 1234567',
			'!link 482913 ',
			'!link  482913',
			'!link abcdef',
			'!link ４８２９１３',
		]) {
			expect(classify(entry('INFO', `<Steve> ${text}`), options)).toEqual({
				type: 'link',
				player: 'Steve',
				text,
				code: null,
			});
		}
		expect(classify(entry('INFO', '<Steve> !LINK 482913'), options)).toEqual({
			type: 'link',
			player: 'Steve',
			text: '!LINK 482913',
			code: null,
		});
		expect(classify(entry('INFO', '<Steve> !link-482913'), options)).toMatchObject({ type: 'chat' });
	});

	it('only reads a `!link` from chat at INFO', () => {
		expect(classify(entry('INFO', '!link 482913'), options)).toBeNull();
		expect(classify(entry('INFO', 'System chat: <Steve> !link 482913'), options)).toBeNull();
		expect(classify(entry('WARN', '<Steve> !link 482913'), options)).toBeNull();
	});

	it('never alerts on DEBUG or TRACE', () => {
		expect(classify(entry('DEBUG', 'FAILED TO BIND TO PORT'), options)).toBeNull();
		expect(classify(entry('TRACE', 'anything'), options)).toBeNull();
	});
});
