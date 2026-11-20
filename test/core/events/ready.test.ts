import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/reminders/scheduler.ts', () => ({
	startScheduler: vi.fn(),
}));

import readyEvent from '../../../src/core/events/ready.ts';
import { startScheduler } from '../../../src/reminders/scheduler.ts';

describe('ready event', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('logs the bot tag and starts the scheduler', () => {
		const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const client = { user: { tag: 'TestBot#0000' } };

		readyEvent.execute(client as never);

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('TestBot#0000'));
		expect(startScheduler).toHaveBeenCalledWith(client);
		consoleSpy.mockRestore();
	});

	it('is configured to run once', () => {
		expect(readyEvent.once).toBe(true);
	});
});
