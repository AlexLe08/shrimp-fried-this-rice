import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEntryAssembler, parseLine, parseLog } from '../../../src/minecraft/bridge/parseLine.ts';

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

describe('parseLine', () => {
	it('splits a vanilla line into its parts', () => {
		expect(parseLine('[11:52:22] [Server thread/INFO]: <Steve> hello i am here')).toEqual({
			kind: 'line',
			line: { time: '11:52:22', thread: 'Server thread', level: 'INFO', message: '<Steve> hello i am here' },
		});
	});

	it('keeps slashes that are part of the thread name', () => {
		const parsed = parseLine(
			'[11:45:31] [RCON Client /0:0:0:0:0:0:0:1 #2/INFO]: Thread RCON Client /0:0:0:0:0:0:0:1 shutting down',
		);
		expect(parsed).toMatchObject({
			kind: 'line',
			line: { thread: 'RCON Client /0:0:0:0:0:0:0:1 #2', level: 'INFO' },
		});
	});

	it('strips the carriage return of a log written on Windows', () => {
		expect(parseLine('[11:48:05] [Server thread/INFO]: Stopping server\r')).toMatchObject({
			line: { message: 'Stopping server' },
		});
	});

	it('treats a line with no prefix as a continuation', () => {
		expect(parseLine('\tat java.base/java.lang.Thread.run(Thread.java:1583)')).toEqual({
			kind: 'continuation',
			text: '\tat java.base/java.lang.Thread.run(Thread.java:1583)',
		});
	});

	it('does not take an unknown level for a prefix', () => {
		expect(parseLine('[11:48:05] [Server thread/NOTICE]: hello').kind).toBe('continuation');
	});
});

describe('createEntryAssembler', () => {
	it('attaches a stack trace to the entry before it and completes the entry on the next prefixed line', () => {
		const assembler = createEntryAssembler();
		expect(assembler.push('[12:06:00] [Server thread/ERROR]: Encountered an unexpected exception')).toBeNull();
		expect(assembler.push('java.lang.IllegalStateException: Example failure')).toBeNull();
		expect(assembler.push('\tat a.b(C.java:1)')).toBeNull();
		const done = assembler.push('[12:06:01] [Server thread/INFO]: next');
		expect(done).toMatchObject({
			level: 'ERROR',
			details: ['java.lang.IllegalStateException: Example failure', '\tat a.b(C.java:1)'],
		});
		expect(assembler.flush()).toMatchObject({ message: 'next', details: [] });
		expect(assembler.flush()).toBeNull();
	});

	it('drops blank lines and lines from before the first prefixed line', () => {
		const assembler = createEntryAssembler();
		expect(assembler.push('half a line from before the helper started')).toBeNull();
		expect(assembler.push('[12:00:00] [Server thread/INFO]: first')).toBeNull();
		expect(assembler.push('')).toBeNull();
		expect(assembler.flush()).toMatchObject({ message: 'first', details: [] });
	});
});

describe('parseLog on the 26.3 fixtures', () => {
	it('reads every line of the startup log as its own entry', () => {
		const entries = parseLog(fixture('vanilla-26.3-startup.log'));
		expect(entries).toHaveLength(35);
		expect(entries.every((entry) => entry.details.length === 0)).toBe(true);
	});

	it('reads the stopping log, RCON threads included', () => {
		const entries = parseLog(fixture('vanilla-26.3-stopping.log'));
		expect(entries).toHaveLength(24);
		expect(entries.map((entry) => entry.thread)).toContain('RCON Client /0:0:0:0:0:0:0:1 #2');
	});
});
