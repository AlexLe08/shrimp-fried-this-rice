import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/scheduler.ts', () => ({ stopScheduler: vi.fn() }));
vi.mock('../../src/core/database.ts', () => ({ closeDatabase: vi.fn() }));
vi.mock('../../src/dashboard/server.ts', () => ({ stopDashboard: vi.fn() }));

import { shutdown, __resetShutdownStateForTests } from '../../src/core/shutdown.ts';
import { stopScheduler } from '../../src/core/scheduler.ts';
import { closeDatabase } from '../../src/core/database.ts';
import { stopDashboard } from '../../src/dashboard/server.ts';

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

	it('waits for the scheduler to stop before destroying the client and closing the database', async () => {
		let finishStopping!: () => void;
		vi.mocked(stopScheduler).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finishStopping = resolve;
			}),
		);
		const destroy = vi.fn().mockResolvedValue(undefined);

		const done = shutdown({ destroy } as never, 'SIGTERM');
		await Promise.resolve();
		expect(destroy).not.toHaveBeenCalled();
		expect(closeDatabase).not.toHaveBeenCalled();

		finishStopping();
		await done;
		expect(destroy).toHaveBeenCalled();
		expect(closeDatabase).toHaveBeenCalled();
	});

	it('waits for the dashboard to stop before stopping the scheduler, destroying the client and closing the database', async () => {
		let finishStopping!: () => void;
		vi.mocked(stopDashboard).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finishStopping = resolve;
			}),
		);
		const destroy = vi.fn().mockResolvedValue(undefined);

		const done = shutdown({ destroy } as never, 'SIGTERM');
		await Promise.resolve();
		expect(stopDashboard).toHaveBeenCalled();
		expect(stopScheduler).not.toHaveBeenCalled();
		expect(destroy).not.toHaveBeenCalled();
		expect(closeDatabase).not.toHaveBeenCalled();

		finishStopping();
		await done;
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
