import { describe, expect, it } from 'vitest';
import type { GatedAlert } from '../../../src/minecraft/bridge/alertGate.ts';
import {
	alertMessage,
	escapeChat,
	eventMessage,
	MAX_CONTENT,
	summaryMessage,
	truncate,
} from '../../../src/minecraft/bridge/messages.ts';

const gated = (message: string, details: string[] = [], extra: Partial<GatedAlert> = {}): GatedAlert => ({
	alert: { type: 'alert', kind: 'error', level: 'ERROR', message, details },
	repeats: 0,
	capped: 0,
	...extra,
});

describe('eventMessage', () => {
	it("posts server events under the server's name", () => {
		expect(eventMessage({ type: 'started', seconds: 8.123 }, 'Survival')).toEqual({
			content: '🟢 **Survival** is up (started in 8.123 s)',
			username: 'Survival',
		});
		expect(eventMessage({ type: 'stopping' }, 'Survival').content).toBe('🔴 **Survival** is stopping');
		expect(eventMessage({ type: 'joined', player: 'Steve' }, 'Survival')).toEqual({
			content: '➕ **Steve** joined',
			username: 'Survival',
		});
		expect(eventMessage({ type: 'left', player: 'Steve' }, 'Survival').content).toBe('➖ **Steve** left');
	});

	it('escapes Markdown in a player name', () => {
		expect(eventMessage({ type: 'joined', player: '__bob__' }, 'S').content).toBe('➕ **\\_\\_bob\\_\\_** joined');
	});

	it("posts chat under the player's name, escaped to read as typed", () => {
		expect(eventMessage({ type: 'chat', player: 'Steve', text: 'hi @everyone' }, 'Survival')).toEqual({
			content: 'hi \\@everyone',
			username: 'Steve',
		});
	});
});

describe('escapeChat', () => {
	it('leaves plain chat alone', () => {
		expect(escapeChat('hello i am here, what is that?')).toBe('hello i am here, what is that?');
	});

	it('escapes formatting: headings, subtext, quotes, bold, spoilers, code, masked links', () => {
		expect(escapeChat('# big')).toBe('\\# big');
		expect(escapeChat('-# small')).toBe('\\-\\# small');
		expect(escapeChat('> quoted')).toBe('\\> quoted');
		expect(escapeChat('**bold** __under__ ~~gone~~')).toBe('\\*\\*bold\\*\\* \\_\\_under\\_\\_ \\~\\~gone\\~\\~');
		expect(escapeChat('||secret||')).toBe('\\|\\|secret\\|\\|');
		expect(escapeChat('```js')).toBe('\\`\\`\\`js');
		expect(escapeChat('[free nitro](https://example.com)')).toBe('\\[free nitro\\]\\(https://example.com)');
	});

	it('shows mentions, channels, timestamps and custom emoji as their text', () => {
		expect(escapeChat('<@123> <#456> <t:1700000000> <:pog:789> @here')).toBe(
			'\\<\\@123\\> \\<\\#456\\> \\<t:1700000000\\> \\<:pog:789\\> \\@here',
		);
	});

	it('keeps a leading number from becoming a list', () => {
		expect(escapeChat('1. first')).toBe('1\\. first');
		expect(escapeChat('it was 1.5 blocks')).toBe('it was 1.5 blocks');
	});

	it('leaves links intact, so they stay clickable', () => {
		expect(escapeChat('look at https://example.com/a_b_c?x=1 and *this*')).toBe(
			'look at https://example.com/a_b_c?x=1 and \\*this\\*',
		);
	});
});

describe('alertMessage', () => {
	it('puts the message and stack trace in a code block', () => {
		const message = alertMessage(
			gated('Encountered an unexpected exception', ['java.lang.NullPointerException']),
			'Survival',
		);
		expect(message).toEqual({
			content:
				'⚠️ **Survival**: Error (ERROR)\n```\nEncountered an unexpected exception\njava.lang.NullPointerException\n```',
			username: 'Survival',
		});
	});

	it('names the kind for a port in use and for lag', () => {
		const bind = gated('**** FAILED TO BIND TO PORT!');
		bind.alert = { ...bind.alert, kind: 'bind-failed', level: 'WARN' };
		expect(alertMessage(bind, 'S').content).toContain("Can't bind to its port");
		const lag = gated("Can't keep up!");
		lag.alert = { ...lag.alert, kind: 'lag', level: 'WARN' };
		expect(alertMessage(lag, 'S').content).toContain('Lagging');
	});

	it('says how often it repeated and how many the cap held back', () => {
		const content = alertMessage(gated('boom', [], { repeats: 3, capped: 1 }), 'S').content;
		expect(
			content.endsWith('\nSeen 3 more times since it last posted. 1 other alert was held back by the per-minute cap.'),
		).toBe(true);
	});

	it('keeps any run of backticks in the log from closing the code block', () => {
		for (const text of ['a ``` b', '````', '``````', '`` ``']) {
			const content = alertMessage(gated(text), 'S').content;
			expect(content.match(/```/g)).toHaveLength(2);
		}
	});

	it('drops trailing stack trace lines to fit, saying how many', () => {
		const details = Array.from(
			{ length: 200 },
			(_, index) => `\tat com.example.Frame${index}.run(Frame.java:${index})`,
		);
		const content = alertMessage(gated('boom', details), 'S').content;
		expect(content.length).toBeLessThanOrEqual(MAX_CONTENT);
		expect(content).toContain('Frame0.run');
		expect(content).toMatch(/… \d+ more lines\n```$/);
		const shown = content.split('\n').filter((line) => line.startsWith('\tat ')).length;
		expect(content).toContain(`… ${200 - shown} more lines`);
	});

	it('cuts a single line too long to fit', () => {
		const content = alertMessage(gated('x'.repeat(3000), ['\tat a']), 'S').content;
		expect(content.length).toBeLessThanOrEqual(MAX_CONTENT);
		expect(content).toMatch(/x…\n… 1 more line\n```$/);
	});
});

describe('summaryMessage', () => {
	it('is null when there is nothing to report', () => {
		expect(summaryMessage({ repeated: [], capped: 0 }, 'S')).toBeNull();
	});

	it('lists repeated alerts and the capped count in one message', () => {
		const message = summaryMessage({ repeated: [gated('boom `x`', [], { repeats: 4 })], capped: 2 }, 'Survival');
		expect(message).toEqual({
			content:
				'📋 **Survival**: since the last alerts\n• Error repeated 4 more times: `boom ˋxˋ`\n• 2 more alerts were held back by the per-minute cap',
			username: 'Survival',
		});
	});

	it('stays within the limit however many alerts repeated', () => {
		const repeated = Array.from({ length: 100 }, (_, index) =>
			gated(`error number ${index} ${'y'.repeat(100)}`, [], { repeats: 1 }),
		);
		expect(summaryMessage({ repeated, capped: 0 }, 'S')!.content.length).toBeLessThanOrEqual(MAX_CONTENT);
	});
});

describe('truncate', () => {
	it('leaves short text alone', () => {
		expect(truncate('short')).toBe('short');
	});

	it('never splits an emoji', () => {
		const text = `${'a'.repeat(8)}😀😀`;
		expect(truncate(text, 10)).toBe(`${'a'.repeat(8)}…`);
	});
});
