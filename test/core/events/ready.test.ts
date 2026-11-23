import { describe, it, expect, vi, beforeEach } from 'vitest';

const reminderChecks = [{ name: 'Guild reminder', run: vi.fn() }];
const recruitCheck = { name: 'Recruit follow-up', run: vi.fn() };
const backupCheck = { name: 'Daily backup', run: vi.fn() };

vi.mock('../../../src/core/scheduler.ts', () => ({
	startScheduler: vi.fn(),
}));
vi.mock('../../../src/reminders/dueReminders.ts', () => ({
	dueReminderChecks: vi.fn(() => reminderChecks),
}));
vi.mock('../../../src/ffxiv/recruit/followUps.ts', () => ({
	recruitFollowUpCheck: vi.fn(() => recruitCheck),
}));
// The tests' database is in memory, which has no backups.
vi.mock('../../../src/core/database.ts', () => ({
	db: { name: 'the database' },
	backupDirectory: vi.fn((): string | null => null),
}));
vi.mock('../../../src/core/backup.ts', () => ({
	dailyBackupCheck: vi.fn(() => backupCheck),
}));

import readyEvent from '../../../src/core/events/ready.ts';
import { startScheduler } from '../../../src/core/scheduler.ts';
import { dueReminderChecks } from '../../../src/reminders/dueReminders.ts';
import { recruitFollowUpCheck } from '../../../src/ffxiv/recruit/followUps.ts';
import { backupDirectory, db } from '../../../src/core/database.ts';
import { dailyBackupCheck } from '../../../src/core/backup.ts';

describe('ready event', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("logs the bot tag and starts the scheduler with the reminders' and recruits' checks", () => {
		const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const client = { user: { tag: 'TestBot#0000' } };

		readyEvent.execute(client as never);

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('TestBot#0000'));
		expect(dueReminderChecks).toHaveBeenCalledWith(client);
		expect(recruitFollowUpCheck).toHaveBeenCalledWith(client);
		expect(startScheduler).toHaveBeenCalledWith([...reminderChecks, recruitCheck]);
		expect(dailyBackupCheck).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('adds the daily backup check when the database is a file', () => {
		vi.mocked(backupDirectory).mockReturnValueOnce('/srv/bot/backups');
		const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		readyEvent.execute({ user: { tag: 'TestBot#0000' } } as never);

		expect(dailyBackupCheck).toHaveBeenCalledWith(db, '/srv/bot/backups');
		expect(startScheduler).toHaveBeenCalledWith([...reminderChecks, recruitCheck, backupCheck]);
		consoleSpy.mockRestore();
	});

	it('is configured to run once', () => {
		expect(readyEvent.once).toBe(true);
	});
});
