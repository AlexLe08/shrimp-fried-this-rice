import type { GuildReminder } from './storage.ts';
import { isSnoozed } from './snooze.ts';

/**
 * Where a server's reminder stands, for the status embed and the dashboard,
 * which word it each their own way. `at` is a time in ms.
 */
export type ReminderState =
	| { kind: 'paused' }
	| { kind: 'disabled' }
	| { kind: 'snoozed'; at: number }
	| { kind: 'due' }
	| { kind: 'scheduled'; at: number };

export function reminderState(reminder: GuildReminder, masterEnabled: boolean, now: number): ReminderState {
	if (!masterEnabled) return { kind: 'paused' };
	if (!reminder.enabled) return { kind: 'disabled' };

	const nextFireMs = reminder.last_sent_at + reminder.interval_minutes * 60_000;

	if (isSnoozed(reminder.snoozed_until, now)) {
		// Sends at whichever comes later: the snooze's end or its usual time.
		return { kind: 'snoozed', at: Math.max(reminder.snoozed_until, nextFireMs) };
	}
	if (reminder.last_sent_at === 0 || nextFireMs <= now) return { kind: 'due' };
	return { kind: 'scheduled', at: nextFireMs };
}
