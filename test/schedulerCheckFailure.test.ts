import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from 'discord.js';
import { createMockClient } from './mocks.ts';

// Its own file: the storage mock below would replace the real database for
// every other scheduler test.
vi.mock('../src/storage.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/storage.ts')>()),
	getDueGuildReminders: vi.fn(),
}));

import { startScheduler, stopScheduler } from '../src/scheduler.ts';
import { getDueGuildReminders } from '../src/storage.ts';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	await stopScheduler();
	vi.useRealTimers();
});

describe('scheduler — a check that throws', () => {
	it('logs the error and keeps polling', async () => {
		vi.mocked(getDueGuildReminders)
			.mockImplementationOnce(() => {
				throw new Error('database is locked');
			})
			.mockReturnValue([]);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		startScheduler(createMockClient() as unknown as Client<true>);
		await vi.advanceTimersByTimeAsync(2 * 60_000);

		expect(consoleSpy).toHaveBeenCalledWith('Guild reminder check failed:', expect.any(Error));
		expect(getDueGuildReminders).toHaveBeenCalledTimes(2);
		consoleSpy.mockRestore();
	});
});
