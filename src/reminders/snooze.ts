// Shared by /reminder snooze and /remindme, which offer the same choices. Not
// under commands/: everything there is loaded as a command.

import { discordTime } from '../core/discord.ts';

const MINUTE_MS = 60_000;

// Fixed choices rather than a free number of minutes: a week is 10080 minutes,
// which nobody should have to type.
export const SNOOZE_DURATION_CHOICES = [
	{ name: '30 minutes', value: 30 },
	{ name: '1 hour', value: 60 },
	{ name: '2 hours', value: 120 },
	{ name: '4 hours', value: 240 },
	{ name: '8 hours', value: 480 },
	{ name: '1 day', value: 1440 },
	{ name: '3 days', value: 4320 },
	{ name: '1 week', value: 10080 },
];

export const AFTER_SNOOZE_SEND_MISSED = 'send_missed';
export const AFTER_SNOOZE_WAIT = 'wait';

export const AFTER_SNOOZE_CHOICES = [
	{ name: 'Send one right away if it was missed (default)', value: AFTER_SNOOZE_SEND_MISSED },
	{ name: 'Wait a full interval after the snooze ends', value: AFTER_SNOOZE_WAIT },
];

// The option is `after` in /reminder snooze and `after_snooze` in /remindme,
// which has no subcommand to scope it.
export const AFTER_SNOOZE_DESCRIPTION =
	'What happens when the snooze ends (default: send one right away if it was missed)';

export function snoozeUntil(now: number, durationMinutes: number): number {
	return now + durationMinutes * MINUTE_MS;
}

export function isSnoozed(snoozedUntil: number, now: number): boolean {
	return snoozedUntil > now;
}

export function describeSnooze(until: number, skipMissed: boolean): string {
	const end = `${discordTime(until, 'f')} (${discordTime(until, 'R')})`;
	return skipMissed
		? `Snoozed until ${end}; the next one goes out a full interval after that.`
		: `Snoozed until ${end}; if one was due in the meantime, it goes out then.`;
}
