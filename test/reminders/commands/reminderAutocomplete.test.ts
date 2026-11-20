import { describe, it, expect, beforeEach } from 'vitest';
import guildReminderCommand from '../../../src/commands/reminderCore/guildreminder.ts';
import {
	createGuildReminder,
	setGuildReminderEnabled,
	snoozeGuildReminder,
	__resetForTests,
} from '../../../src/storage.ts';
import { createMockInteraction } from '../../mockInteraction.ts';

beforeEach(() => {
	__resetForTests();
});

function addReminder(label: string, guildId = 'g1', channelId = 'c1', intervalMinutes = 60) {
	createGuildReminder({ guildId, label, channelId, intervalMinutes, message: 'hi' });
}

function makeGuild(channels: Record<string, string> = { c1: 'general' }) {
	const cache = new Map(Object.entries(channels).map(([id, name]) => [id, { name }]));
	return { id: 'g1', channels: { cache } };
}

async function autocomplete(focused: string, config: Parameters<typeof createMockInteraction>[0] = {}) {
	const interaction = createMockInteraction({
		isAutocomplete: true,
		isChatInputCommand: false,
		inCachedGuild: true,
		guild: makeGuild(),
		focused,
		...config,
	});
	await guildReminderCommand.autocomplete(interaction as never);
	return interaction.respond.mock.calls[0]?.[0] as { name: string; value: string }[];
}

describe('/reminder label autocomplete', () => {
	it("offers every one of this server's labels, alphabetically, when nothing is typed", async () => {
		addReminder('water');
		addReminder('stretch');
		addReminder('other-server', 'g2');

		const choices = await autocomplete('');

		expect(choices.map((c) => c.value)).toEqual(['stretch', 'water']);
	});

	it('puts labels starting with the input before ones that only contain it, case-insensitively', async () => {
		addReminder('drink-water');
		addReminder('water');
		addReminder('stretch');

		const choices = await autocomplete('  WAT ');

		expect(choices.map((c) => c.value)).toEqual(['water', 'drink-water']);
	});

	it('names each choice with its interval and channel, and marks disabled and snoozed ones', async () => {
		const now = Date.now();
		addReminder('water');
		addReminder('stretch', 'g1', 'gone', 30);
		setGuildReminderEnabled('g1', 'stretch', false);
		snoozeGuildReminder('g1', 'stretch', { until: now + 3_600_000, skipMissed: false, now });

		const choices = await autocomplete('');

		expect(choices).toEqual([
			// An uncached channel is left out of the name rather than shown as an id.
			{ name: 'stretch · every 30m · disabled · 💤 snoozed', value: 'stretch' },
			{ name: 'water · every 60m · #general', value: 'water' },
		]);
	});

	it("keeps each choice's name within Discord's 100 characters", async () => {
		const label = 'x'.repeat(50);
		addReminder(label);

		const choices = await autocomplete('', { guild: makeGuild({ c1: 'y'.repeat(100) }) });

		expect(choices[0]?.name).toHaveLength(100);
		expect(choices[0]?.value).toBe(label);
	});

	it('shortens a long channel name, not the status, and never splits an emoji', async () => {
		const now = Date.now();
		addReminder('a');
		setGuildReminderEnabled('g1', 'a', false);
		snoozeGuildReminder('g1', 'a', { until: now + 3_600_000, skipMissed: false, now });

		const choices = await autocomplete('', { guild: makeGuild({ c1: '💤'.repeat(50) }) });
		const name = choices[0]?.name ?? '';

		expect(name.startsWith('a · every 60m · disabled · 💤 snoozed · #💤')).toBe(true);
		expect(name.endsWith('…')).toBe(true);
		expect(name.length).toBeLessThanOrEqual(100);
		expect(name.isWellFormed()).toBe(true);
	});

	it("offers at most Discord's 25 choices", async () => {
		for (let i = 0; i < 30; i++) addReminder(`r${String(i).padStart(2, '0')}`);

		const choices = await autocomplete('');

		expect(choices).toHaveLength(25);
	});

	it('offers nothing outside a cached server', async () => {
		addReminder('water');

		const choices = await autocomplete('', { inCachedGuild: false });

		expect(choices).toEqual([]);
	});
});
