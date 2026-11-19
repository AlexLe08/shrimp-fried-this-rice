import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import guildReminderCommand from '../../../src/commands/reminderCore/guildreminder.ts';
import remindmeCommand from '../../../src/commands/reminderCore/remindme.ts';
import {
	createGuildReminder,
	getGuildReminderByLabel,
	setGuildReminderEnabled,
	snoozeGuildReminder,
	upsertUserSettings,
	getUserSettings,
	snoozeUser,
	__resetForTests,
} from '../../../src/storage.ts';
import { createMockInteraction } from '../../mockInteraction.ts';

const NOW = 1_800_000_000_000;
const ONE_MINUTE = 60_000;
const USER = { id: 'u1', username: 'tester' };

function makeGuild() {
	return { id: 'g1', name: 'Test Guild', members: { me: {} } };
}

function guildCommand(options: Parameters<typeof createMockInteraction>[0]['options']) {
	return createMockInteraction({ inCachedGuild: true, guild: makeGuild(), options });
}

function replyContent(interaction: ReturnType<typeof createMockInteraction>): string {
	const [[reply]] = interaction.reply.mock.calls as [[{ content: string }]];
	return reply.content;
}

beforeEach(() => {
	__resetForTests();
	vi.spyOn(Date, 'now').mockReturnValue(NOW);
	createGuildReminder({ guildId: 'g1', label: 'water', channelId: 'c1', intervalMinutes: 60, message: 'hi' });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('/reminder snooze', () => {
	it('rejects a nonexistent label', async () => {
		const interaction = guildCommand({ subcommand: 'snooze', strings: { label: 'nope' }, integers: { duration: 60 } });

		await guildReminderCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain('No reminder found');
	});

	it('snoozes for the chosen duration, sending a missed one afterwards by default', async () => {
		const interaction = guildCommand({
			subcommand: 'snooze',
			strings: { label: 'WATER' },
			integers: { duration: 120 },
		});

		await guildReminderCommand.execute(interaction as never);

		const reminder = getGuildReminderByLabel('g1', 'water');
		expect(reminder?.snoozed_until).toBe(NOW + 120 * ONE_MINUTE);
		expect(reminder?.last_sent_at).toBe(0);
		expect(replyContent(interaction)).toContain(`Snoozed until <t:${(NOW + 120 * ONE_MINUTE) / 1000}:f>`);
		expect(replyContent(interaction)).toContain('if one was due in the meantime');
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.anything() }));
	});

	it('with after: wait, moves the next send a full interval past the snooze', async () => {
		const interaction = guildCommand({
			subcommand: 'snooze',
			strings: { label: 'water', after: 'wait' },
			integers: { duration: 30 },
		});

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'water')?.last_sent_at).toBe(NOW + 30 * ONE_MINUTE);
		expect(replyContent(interaction)).toContain('a full interval after that');
	});

	it('says a disabled reminder stays off after the snooze', async () => {
		setGuildReminderEnabled('g1', 'water', false);
		const interaction = guildCommand({ subcommand: 'snooze', strings: { label: 'water' }, integers: { duration: 60 } });

		await guildReminderCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain('also disabled');
	});
});

describe('/reminder unsnooze', () => {
	it('rejects a nonexistent label', async () => {
		const interaction = guildCommand({ subcommand: 'unsnooze', strings: { label: 'nope' } });

		await guildReminderCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain('No reminder found');
	});

	it('says so when the reminder is not snoozed', async () => {
		const interaction = guildCommand({ subcommand: 'unsnooze', strings: { label: 'water' } });

		await guildReminderCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain("isn't snoozed");
	});

	it('treats a snooze that has already ended as not snoozed', async () => {
		snoozeGuildReminder('g1', 'water', { until: NOW - 1, skipMissed: false, now: NOW - ONE_MINUTE });
		const interaction = guildCommand({ subcommand: 'unsnooze', strings: { label: 'water' } });

		await guildReminderCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain("isn't snoozed");
	});

	it('ends an active snooze', async () => {
		snoozeGuildReminder('g1', 'water', { until: NOW + 60 * ONE_MINUTE, skipMissed: false, now: NOW });
		const interaction = guildCommand({ subcommand: 'unsnooze', strings: { label: 'water' } });

		await guildReminderCommand.execute(interaction as never);

		expect(getGuildReminderByLabel('g1', 'water')?.snoozed_until).toBe(0);
		expect(replyContent(interaction)).toContain('no longer snoozed');
	});
});

describe('/reminder list', () => {
	it('shows when a snoozed reminder comes back', async () => {
		const until = NOW + 60 * ONE_MINUTE;
		snoozeGuildReminder('g1', 'water', { until, skipMissed: false, now: NOW });
		const interaction = guildCommand({ subcommand: 'list' });

		await guildReminderCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain(`enabled, snoozed until <t:${until / 1000}:f>`);
	});
});

describe('/remindme snooze', () => {
	function remindme(options: Parameters<typeof createMockInteraction>[0]['options']) {
		return createMockInteraction({ user: USER, options });
	}

	beforeEach(() => {
		upsertUserSettings({ userId: 'u1', dmEnabled: true, intervalMinutes: 30, message: 'Stretch!' });
	});

	it('snoozes existing DM reminders without changing the other settings', async () => {
		const interaction = remindme({ integers: { snooze: 480 } });

		await remindmeCommand.execute(interaction as never);

		expect(getUserSettings('u1')).toMatchObject({
			dm_enabled: 1,
			interval_minutes: 30,
			message: 'Stretch!',
			snoozed_until: NOW + 480 * ONE_MINUTE,
		});
		expect(replyContent(interaction)).toContain('Snoozed until');
		expect(replyContent(interaction)).not.toContain('Interval:');
	});

	it('with after_snooze: wait, moves the next DM a full interval past the snooze', async () => {
		const interaction = remindme({ integers: { snooze: 60 }, strings: { after_snooze: 'wait' } });

		await remindmeCommand.execute(interaction as never);

		expect(getUserSettings('u1')?.last_sent_at).toBe(NOW + 60 * ONE_MINUTE);
	});

	it('changes settings and snoozes in one command', async () => {
		const interaction = remindme({ integers: { interval: 15, snooze: 60 } });

		await remindmeCommand.execute(interaction as never);

		expect(getUserSettings('u1')).toMatchObject({ interval_minutes: 15, snoozed_until: NOW + 60 * ONE_MINUTE });
		expect(replyContent(interaction)).toContain('every 15 minutes');
		expect(replyContent(interaction)).toContain('Snoozed until');
	});

	it('notes that nothing sends while DM reminders are off', async () => {
		upsertUserSettings({ userId: 'u1', dmEnabled: false, intervalMinutes: 30, message: 'Stretch!' });
		const interaction = remindme({ integers: { snooze: 60 } });

		await remindmeCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain('turned off');
	});

	it('cancels an active snooze', async () => {
		snoozeUser('u1', { until: NOW + 60 * ONE_MINUTE, skipMissed: false, now: NOW });
		const interaction = remindme({ integers: { snooze: 0 } });

		await remindmeCommand.execute(interaction as never);

		expect(getUserSettings('u1')?.snoozed_until).toBe(0);
		expect(replyContent(interaction)).toContain('no longer snoozed');
	});

	it('says so when cancelling with no snooze active', async () => {
		const interaction = remindme({ integers: { snooze: 0 } });

		await remindmeCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain("weren't snoozed");
	});

	it('rejects after_snooze without a snooze duration', async () => {
		const interaction = remindme({ strings: { after_snooze: 'wait' } });

		await remindmeCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain('only applies together with');
		expect(getUserSettings('u1')?.snoozed_until).toBe(0);
	});

	it('refuses to snooze before DM reminders are set up', async () => {
		const interaction = createMockInteraction({
			user: { id: 'u2', username: 'new' },
			options: { integers: { snooze: 60 } },
		});

		await remindmeCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain('nothing to snooze');
		expect(getUserSettings('u2')).toBeUndefined();
	});

	it('lets a new user set up and snooze in one command', async () => {
		const interaction = createMockInteraction({
			user: { id: 'u2', username: 'new' },
			options: { booleans: { enabled: true }, integers: { snooze: 60 } },
		});

		await remindmeCommand.execute(interaction as never);

		expect(getUserSettings('u2')).toMatchObject({ dm_enabled: 1, snoozed_until: NOW + 60 * ONE_MINUTE });
	});

	it('shows an active snooze when viewing settings', async () => {
		const until = NOW + 60 * ONE_MINUTE;
		snoozeUser('u1', { until, skipMissed: false, now: NOW });
		const interaction = remindme({});

		await remindmeCommand.execute(interaction as never);

		expect(replyContent(interaction)).toContain(`Snoozed until <t:${until / 1000}:f>`);
	});
});
