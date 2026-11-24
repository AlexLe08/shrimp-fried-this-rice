import { describe, expect, it } from 'vitest';
import { LOGINS_PER_MINUTE, createLoginGate } from '../../src/dashboard/loginGate.ts';

function gateAt(start: number) {
	let time = start;
	const gate = createLoginGate(() => time);
	return {
		gate,
		advance(ms: number) {
			time += ms;
		},
	};
}

function takeAll(gate: { tryTake(): boolean }, count: number): boolean[] {
	return Array.from({ length: count }, () => gate.tryTake());
}

describe('login gate', () => {
	it(`allows ${LOGINS_PER_MINUTE} logins a minute, then refuses until the minute is over`, () => {
		const { gate, advance } = gateAt(0);

		expect(takeAll(gate, LOGINS_PER_MINUTE).every(Boolean)).toBe(true);
		expect(gate.tryTake()).toBe(false);
		advance(59_999);
		expect(gate.tryTake()).toBe(false);
		advance(1);
		expect(gate.tryTake()).toBe(true);
	});

	it("refuses every login until Discord's Retry-After has passed", () => {
		const { gate, advance } = gateAt(1000);
		gate.blockFor(5000);

		expect(gate.tryTake()).toBe(false);
		advance(4999);
		expect(gate.tryTake()).toBe(false);
		advance(1);
		expect(gate.tryTake()).toBe(true);
	});

	it('keeps the later end when told to wait twice', () => {
		const { gate, advance } = gateAt(0);
		gate.blockFor(10_000);
		gate.blockFor(1000);

		advance(5000);
		expect(gate.tryTake()).toBe(false);
	});
});
