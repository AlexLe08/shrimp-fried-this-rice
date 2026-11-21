import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockClient } from '../mocks.ts';

// Its own file: the storage mock below would replace the real database for
// every other due reminder test.
vi.mock('../../src/reminders/storage.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/reminders/storage.ts')>()),
	getDueGuildReminders: vi.fn(),
}));

import { startScheduler, stopScheduler } from '../../src/core/scheduler.ts';
import { dueReminderChecks } from '../../src/reminders/dueReminders.ts';
import { getDueGuildReminders } from '../../src/reminders/storage.ts';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	await stopScheduler();
	vi.useRealTimers();
});

describe('due reminder checks — a check that throws', () => {
	it('logs the error and keeps polling', async () => {
		vi.mocked(getDueGuildReminders)
			.mockImplementationOnce(() => {
				throw new Error('database is locked');
			})
			.mockReturnValue([]);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(dueReminderChecks(createMockClient()));
		await vi.advanceTimersByTimeAsync(2 * 60_000);

		expect(consoleSpy).toHaveBeenCalledWith('Guild reminder check failed:', expect.any(Error));
		expect(getDueGuildReminders).toHaveBeenCalledTimes(2);
		consoleSpy.mockRestore();
	});
});
