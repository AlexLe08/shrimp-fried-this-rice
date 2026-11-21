import { describe, it, expect, vi, beforeEach } from 'vitest';

const reminderChecks = [{ name: 'Guild reminder', run: vi.fn() }];

vi.mock('../../../src/core/scheduler.ts', () => ({
	startScheduler: vi.fn(),
}));
vi.mock('../../../src/reminders/dueReminders.ts', () => ({
	dueReminderChecks: vi.fn(() => reminderChecks),
}));

import readyEvent from '../../../src/core/events/ready.ts';
import { startScheduler } from '../../../src/core/scheduler.ts';
import { dueReminderChecks } from '../../../src/reminders/dueReminders.ts';

describe('ready event', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("logs the bot tag and starts the scheduler with the reminders' checks", () => {
		const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const client = { user: { tag: 'TestBot#0000' } };

		readyEvent.execute(client as never);

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('TestBot#0000'));
		expect(dueReminderChecks).toHaveBeenCalledWith(client);
		expect(startScheduler).toHaveBeenCalledWith(reminderChecks);
		consoleSpy.mockRestore();
	});

	it('is configured to run once', () => {
		expect(readyEvent.once).toBe(true);
	});
});
