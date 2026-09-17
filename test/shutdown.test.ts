import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/scheduler.ts', () => ({ stopScheduler: vi.fn() }));
vi.mock('../src/storage.ts', () => ({ closeDatabase: vi.fn() }));

import { shutdown, __resetShutdownStateForTests } from '../src/shutdown.ts';
import { stopScheduler } from '../src/scheduler.ts';
import { closeDatabase } from '../src/storage.ts';

beforeEach(() => {
	vi.clearAllMocks();
	__resetShutdownStateForTests();
});

describe('shutdown function', () => {
	it('stops the scheduler, destroys the client, and closes the database', async () => {
		const destroy = vi.fn().mockResolvedValue(undefined);
		await shutdown({ destroy } as never, 'SIGTERM');

		expect(stopScheduler).toHaveBeenCalled();
		expect(destroy).toHaveBeenCalled();
		expect(closeDatabase).toHaveBeenCalled();
	});

	it('still closes the database even if destroying the client fails', async () => {
		const destroy = vi.fn().mockRejectedValue(new Error('destroy failed'));
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await shutdown({ destroy } as never, 'SIGTERM');

		expect(closeDatabase).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('does nothing on a second call once a shutdown is already underway', async () => {
		const destroy = vi.fn().mockResolvedValue(undefined);

		await shutdown({ destroy } as never, 'SIGTERM');
		await shutdown({ destroy } as never, 'SIGINT');

		expect(destroy).toHaveBeenCalledTimes(1);
	});
});