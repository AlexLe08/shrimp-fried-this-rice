import { describe, it, expect, beforeEach } from 'vitest';
import remindmeCommand from '../../../src/commands/reminderCore/remindme.ts';
import { getUserSettings, upsertUserSettings, __resetForTests } from '../../../src/storage.ts';
import { createMockInteraction } from '../../mockInteraction.ts';

beforeEach(() => {
	__resetForTests();
});

describe('/remindme — reset', () => {
	it('deletes existing settings and confirms, ignoring any other options provided', async () => {
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 30, message: 'hi' });

		const interaction = createMockInteraction({
			user: { id: 'u1', username: 'tester' },
			options: { booleans: { reset: true, enabled: true }, integers: { interval: 99 } },
		});
		await remindmeCommand.execute(interaction as never);

		expect(getUserSettings('u1')).toBeUndefined();
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('deleted') }),
		);
	});
});

describe('/remindme — view mode (no options provided)', () => {
	it('prompts to get started when no settings exist yet', async () => {
		const interaction = createMockInteraction({ user: { id: 'u1', username: 'tester' } });
		await remindmeCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("haven't set up") }),
		);
	});

	it('shows current settings when they already exist', async () => {
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 45, message: 'Stretch!' });

		const interaction = createMockInteraction({ user: { id: 'u1', username: 'tester' } });
		await remindmeCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('Stretch!') }),
		);
	});
});

describe('/remindme — update mode', () => {
	it('creates settings for a first-time user, applying defaults for unspecified fields', async () => {
		const interaction = createMockInteraction({
			user: { id: 'u1', username: 'tester' },
			options: { booleans: { enabled: true } },
		});
		await remindmeCommand.execute(interaction as never);

		const settings = getUserSettings('u1');
		expect(settings?.dm_enabled).toBe(1);
		expect(settings?.interval_minutes).toBe(60); // DEFAULT_INTERVAL
		expect(settings?.message).toBe('Time for a quick break!'); // DEFAULT_MESSAGE
	});

	it('updates only the specified field, preserving the rest of an existing row', async () => {
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 30, message: 'original message' });

		const interaction = createMockInteraction({
			user: { id: 'u1', username: 'tester' },
			options: { integers: { interval: 15 } },
		});
		await remindmeCommand.execute(interaction as never);

		const settings = getUserSettings('u1');
		expect(settings?.interval_minutes).toBe(15);
		expect(settings?.message).toBe('original message'); // unchanged
		expect(settings?.dm_enabled).toBe(1); // unchanged
	});
});