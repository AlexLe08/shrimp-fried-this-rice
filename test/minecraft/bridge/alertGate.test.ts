import { describe, expect, it } from 'vitest';
import { createAlertGate, DEFAULT_ALERT_GATE } from '../../../src/minecraft/bridge/alertGate.ts';
import type { AlertKind } from '../../../src/minecraft/bridge/classify.ts';

const MINUTE = 60_000;
const alert = (kind: AlertKind, message: string) => ({
	type: 'alert' as const,
	kind,
	level: kind === 'error' ? ('ERROR' as const) : ('WARN' as const),
	message,
	details: [],
});
const lag = (ms: number) => alert('lag', `Can't keep up! Is the server overloaded? Running ${ms}ms or 40 ticks behind`);

describe('createAlertGate', () => {
	it('posts an error straight away', () => {
		const gate = createAlertGate();
		expect(gate.check(alert('error', 'boom'), 0)).toEqual({ alert: alert('error', 'boom'), repeats: 0, capped: 0 });
	});

	it("holds back the owner's usual lag pairs", () => {
		const gate = createAlertGate();
		// The stopping fixture's pattern: a pair every few minutes.
		for (const minute of [0, 0.3, 41, 41.3, 47, 47.4, 52, 52.3]) {
			expect(gate.check(lag(2000 + minute), minute * MINUTE)).toBeNull();
		}
	});

	it('alerts once lag repeats five times within five minutes', () => {
		const gate = createAlertGate();
		for (let i = 0; i < 4; i++) expect(gate.check(lag(2000 + i), i * MINUTE)).toBeNull();
		expect(gate.check(lag(9000), 4 * MINUTE)).toMatchObject({ alert: { kind: 'lag' } });
	});

	it('starts counting lag again after an alert', () => {
		const gate = createAlertGate({ ...DEFAULT_ALERT_GATE, dedupeWindowMs: 0 });
		for (let i = 0; i < 5; i++) gate.check(lag(2000), i * 1000);
		expect(gate.check(lag(2000), 6000)).toBeNull();
	});

	it('posts the same message once in ten minutes, counting the copies, even with different numbers', () => {
		const gate = createAlertGate();
		expect(gate.check(alert('error', 'Chunk 12 failed'), 0)).not.toBeNull();
		expect(gate.check(alert('error', 'Chunk 13 failed'), MINUTE)).toBeNull();
		expect(gate.check(alert('error', 'Chunk 14 failed'), 2 * MINUTE)).toBeNull();
		expect(gate.check(alert('error', 'Chunk 15 failed'), 10 * MINUTE)).toMatchObject({ repeats: 2 });
	});

	it('reports the count of a burst that stopped, once', () => {
		const gate = createAlertGate();
		gate.check(alert('error', 'boom'), 0);
		gate.check(alert('error', 'boom'), MINUTE);
		gate.check(alert('error', 'quiet'), 0);
		expect(gate.summaries(9 * MINUTE)).toEqual({ repeated: [], capped: 0 });
		expect(gate.summaries(10 * MINUTE)).toEqual({
			repeated: [{ alert: alert('error', 'boom'), repeats: 1, capped: 0 }],
			capped: 0,
		});
		expect(gate.summaries(20 * MINUTE)).toEqual({ repeated: [], capped: 0 });
		// The window is over, so the next copy posts with nothing left to report.
		expect(gate.check(alert('error', 'boom'), 21 * MINUTE)).toMatchObject({ repeats: 0 });
	});

	it('posts at most five alerts a minute and reports how many it dropped', () => {
		const gate = createAlertGate();
		for (let i = 0; i < 5; i++) expect(gate.check(alert('error', `distinct ${'x'.repeat(i)}`), i)).not.toBeNull();
		expect(gate.check(alert('error', 'sixth'), 10)).toBeNull();
		expect(gate.check(alert('error', 'seventh'), 20)).toBeNull();
		expect(gate.check(alert('error', 'eighth'), MINUTE + 10)).toMatchObject({ repeats: 0, capped: 2 });
	});

	it('reports what the cap dropped when nothing posts after it, once', () => {
		const gate = createAlertGate();
		for (let i = 0; i < 7; i++) gate.check(alert('error', `distinct ${'x'.repeat(i)}`), i);
		expect(gate.summaries(10 * MINUTE).capped).toBe(2);
		expect(gate.summaries(11 * MINUTE).capped).toBe(0);
	});

	it('posts two errors with the same message but different exceptions', () => {
		const gate = createAlertGate();
		const withCause = (cause: string) => ({
			...alert('error', 'Encountered an unexpected exception'),
			details: [cause],
		});
		expect(gate.check(withCause('java.lang.IllegalStateException: one'), 0)).not.toBeNull();
		expect(gate.check(withCause('java.lang.NullPointerException'), MINUTE)).not.toBeNull();
		expect(gate.check(withCause('java.lang.NullPointerException'), 2 * MINUTE)).toBeNull();
	});
});
