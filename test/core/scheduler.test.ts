import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startScheduler, stopScheduler, type ScheduledCheck } from '../../src/core/scheduler.ts';

// The loop itself, with checks that record their calls; the reminder checks
// are tested through it in test/reminders/dueReminders.test.ts.

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
	await stopScheduler();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function check(name: string, run: ScheduledCheck['run'] = () => Promise.resolve()) {
	return { name, run: vi.fn(run) };
}

// A check whose runs last until release() is called.
function blockedCheck(name: string) {
	const pending: (() => void)[] = [];
	const blocked = check(name, () => new Promise<void>((resolve) => pending.push(resolve)));
	return { check: blocked, release: () => pending.splice(0).forEach((resolve) => resolve()) };
}

describe('scheduler', () => {
	it('runs every check on each poll, not before the first', async () => {
		const first = check('First');
		const second = check('Second');

		startScheduler([first, second]);
		expect(first.run).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(2 * 60_000);

		expect(first.run).toHaveBeenCalledTimes(2);
		expect(second.run).toHaveBeenCalledTimes(2);
	});

	it('logs a check that throws, under its name, and keeps polling it and the others', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const failing = check('Failing', () => Promise.reject(new Error('database is locked')));
		const throwing = check('Throwing', () => {
			throw new Error('thrown before returning a promise');
		});
		const other = check('Other');

		startScheduler([failing, throwing, other]);
		await vi.advanceTimersByTimeAsync(2 * 60_000);

		expect(consoleSpy).toHaveBeenCalledWith('Failing check failed:', expect.any(Error));
		expect(consoleSpy).toHaveBeenCalledWith('Throwing check failed:', expect.any(Error));
		expect(failing.run).toHaveBeenCalledTimes(2);
		expect(throwing.run).toHaveBeenCalledTimes(2);
		expect(other.run).toHaveBeenCalledTimes(2);
	});

	it('skips a check still running from an earlier poll, but not the others', async () => {
		const slow = blockedCheck('Slow');
		const fast = check('Fast');

		startScheduler([slow.check, fast]);
		await vi.advanceTimersByTimeAsync(3 * 60_000);

		expect(slow.check.run).toHaveBeenCalledTimes(1);
		expect(fast.run).toHaveBeenCalledTimes(3);

		slow.release();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(slow.check.run).toHaveBeenCalledTimes(2);
		slow.release();
	});

	it('stopScheduler aborts the signal and waits for a check already running', async () => {
		const slow = blockedCheck('Slow');
		startScheduler([slow.check]);
		await vi.advanceTimersByTimeAsync(60_000);
		const signal = slow.check.run.mock.calls[0]?.[0];
		expect(signal?.aborted).toBe(false);

		let stopped = false;
		const stopping = stopScheduler().then(() => {
			stopped = true;
		});
		await Promise.resolve();

		expect(signal?.aborted).toBe(true);
		expect(stopped).toBe(false);

		slow.release();
		await stopping;
		expect(stopped).toBe(true);
	});

	it('stopScheduler clears the interval, and a new start has a signal not yet aborted', async () => {
		const first = check('First');
		startScheduler([first]);
		await stopScheduler();
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(first.run).not.toHaveBeenCalled();

		const second = check('Second');
		startScheduler([second]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(second.run.mock.calls[0]?.[0].aborted).toBe(false);
	});
});
