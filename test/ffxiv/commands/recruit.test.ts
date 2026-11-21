import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import recruitCommand from '../../../src/ffxiv/commands/recruit.ts';
import {
	addRecruit,
	DAY_MS,
	getOpenRecruitByName,
	getOpenRecruits,
	getRecruitSettings,
	markRecruitReminded,
	MAX_OPEN_RECRUITS_PER_GUILD,
	pauseRecruitFollowUps,
	setRecruitSettings,
} from '../../../src/ffxiv/recruit/storage.ts';
import { __resetForTests } from '../../../src/core/database.ts';
import { createMockInteraction, replyContent, type MockOptionsConfig } from '../../mockInteraction.ts';
import { createMockGuild, createMockGuildChannel } from '../../mocks.ts';

const NOW = Date.UTC(2026, 10, 21, 12);

beforeEach(() => {
	__resetForTests();
	vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
	vi.useRealTimers();
});

type Guild = ReturnType<typeof createMockGuild>;

async function run(
	subcommand: string,
	options: Omit<MockOptionsConfig, 'subcommand'> = {},
	guild: Guild = createMockGuild(),
) {
	const interaction = createMockInteraction({
		inCachedGuild: true,
		guild,
		user: { id: 'mod1', username: 'mod' },
		options: { subcommand, ...options },
	});
	await recruitCommand.execute(interaction as never);
	return replyContent(interaction);
}

function addOpen(name: string, overrides: { dueAt?: number; note?: string; addedAt?: number } = {}) {
	return addRecruit({
		guildId: 'g1',
		name,
		note: overrides.note ?? '',
		addedBy: 'mod1',
		addedAt: overrides.addedAt ?? NOW,
		dueAt: overrides.dueAt ?? NOW + 30 * DAY_MS,
	});
}

const seconds = (ms: number) => Math.floor(ms / 1000);

describe('/recruit', () => {
	it('is guild-only, Manage Server by default, and has its subcommands in order', () => {
		const json = recruitCommand.data.toJSON();
		expect(json.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
		expect(json.contexts).toEqual([0]);
		expect(json.options?.map((o) => o.name)).toEqual(['add', 'list', 'edit', 'resolve', 'snooze', 'remove', 'config']);
	});

	it('refuses outside a server', async () => {
		const interaction = createMockInteraction({ inCachedGuild: false, options: { subcommand: 'list' } });
		await recruitCommand.execute(interaction as never);
		expect(replyContent(interaction)).toContain('only be used in a server');
	});

	it('replies ephemerally', async () => {
		const interaction = createMockInteraction({ guild: createMockGuild(), options: { subcommand: 'list' } });
		await recruitCommand.execute(interaction as never);
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.anything() }));
	});
});

describe('/recruit add', () => {
	it("records a trial member due after the server's default, naming the channel", async () => {
		setRecruitSettings('g1', { channelId: 'c1', followUpDays: 14 });

		const reply = await run('add', { strings: { name: ' Alex Le ', note: ' met in Limsa ' } });

		expect(getOpenRecruitByName('g1', 'alex le')).toMatchObject({
			name: 'Alex Le',
			note: 'met in Limsa',
			added_by: 'mod1',
			added_at: NOW,
			due_at: NOW + 14 * DAY_MS,
		});
		expect(reply).toContain('Added **Alex Le**');
		expect(reply).toContain(`in <#c1> <t:${seconds(NOW + 14 * DAY_MS)}:R>`);
		expect(reply).not.toContain('⚠️');
	});

	it('takes its own days, defaults to 30 before any config, and says follow-ups need a channel', async () => {
		await run('add', { strings: { name: 'A' }, integers: { days: 3 } });
		const reply = await run('add', { strings: { name: 'B' } });

		expect(getOpenRecruitByName('g1', 'A')?.due_at).toBe(NOW + 3 * DAY_MS);
		expect(getOpenRecruitByName('g1', 'B')).toMatchObject({ due_at: NOW + 30 * DAY_MS, note: '' });
		expect(reply).toContain('/recruit config channel:');
	});

	it('says when follow-ups are paused', async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		pauseRecruitFollowUps('g1', 'c1');

		expect(await run('add', { strings: { name: 'A' } })).toContain('paused');
	});

	it('refuses a name already open, in any capitals, and a blank one', async () => {
		addOpen('Alex Le');

		expect(await run('add', { strings: { name: 'ALEX LE' } })).toContain('already on the list');
		expect(await run('add', { strings: { name: '   ' } })).toContain('Give the trial member a name');
		expect(getOpenRecruits('g1')).toHaveLength(1);
	});

	it('refuses past the cap of open entries', async () => {
		for (let i = 0; i < MAX_OPEN_RECRUITS_PER_GUILD; i++) addOpen(`R${i}`);

		expect(await run('add', { strings: { name: 'One more' } })).toContain(`maximum of ${MAX_OPEN_RECRUITS_PER_GUILD}`);
	});
});

describe('/recruit edit', () => {
	it('changes the note and name, keeping the due date', async () => {
		addOpen('Alex Le', { note: 'old' });

		const reply = await run('edit', { strings: { name: 'alex le', note: 'new', new_name: 'Alex Li' } });

		expect(getOpenRecruitByName('g1', 'Alex Li')).toMatchObject({ note: 'new', due_at: NOW + 30 * DAY_MS });
		expect(reply).toBe('Updated **Alex Li**: renamed from **Alex Le**; note updated.');
	});

	it('counts days from when they were added, and makes a posted follow-up pending again', async () => {
		const recruit = addOpen('Alex Le', { addedAt: NOW - 20 * DAY_MS, dueAt: NOW - 1 });
		markRecruitReminded(recruit.id, recruit.due_at);

		const reply = await run('edit', { strings: { name: 'Alex Le' }, integers: { days: 45 } });

		expect(getOpenRecruitByName('g1', 'Alex Le')).toMatchObject({ due_at: NOW + 25 * DAY_MS, status: 'pending' });
		expect(reply).toContain(`<t:${seconds(NOW + 25 * DAY_MS)}:R>`);
		expect(await run('edit', { strings: { name: 'Alex Le' }, integers: { days: 5 } })).toContain('follow-up due now');
	});

	it('refuses with nothing to change, a name not open, or a new name another entry has', async () => {
		addOpen('Alex Le');
		addOpen('Taken');

		expect(await run('edit', { strings: { name: 'Alex Le' } })).toContain('Nothing to change');
		expect(await run('edit', { strings: { name: 'Nobody', note: 'x' } })).toContain(
			'No open trial member named **Nobody**',
		);
		expect(await run('edit', { strings: { name: 'Alex Le', new_name: 'taken' } })).toContain('already on the list');
		expect(getOpenRecruitByName('g1', 'Alex Le')).toBeDefined();
	});

	it('allows renaming to the same name in other capitals', async () => {
		addOpen('alex le');

		await run('edit', { strings: { name: 'alex le', new_name: 'Alex Le' } });

		expect(getOpenRecruitByName('g1', 'alex le')?.name).toBe('Alex Le');
	});
});

describe('/recruit resolve, snooze and remove', () => {
	it('resolves an entry as promoted or left, taking it off the list', async () => {
		addOpen('A');
		addOpen('B');

		expect(await run('resolve', { strings: { name: 'a', outcome: 'promoted' } })).toBe(
			"**A** was promoted; they're off the list.",
		);
		expect(await run('resolve', { strings: { name: 'B', outcome: 'left' } })).toBe("**B** left; they're off the list.");
		expect(getOpenRecruits('g1')).toEqual([]);
	});

	it('snoozes from now, making a posted follow-up pending again', async () => {
		const recruit = addOpen('Alex Le', { dueAt: NOW - DAY_MS });
		markRecruitReminded(recruit.id, recruit.due_at);

		const reply = await run('snooze', { strings: { name: 'Alex Le' }, integers: { days: 7 } });

		expect(getOpenRecruitByName('g1', 'Alex Le')).toMatchObject({ due_at: NOW + 7 * DAY_MS, status: 'pending' });
		expect(reply).toContain(`again <t:${seconds(NOW + 7 * DAY_MS)}:R>`);
	});

	it('removes an entry', async () => {
		addOpen('Mistake');

		expect(await run('remove', { strings: { name: 'Mistake' } })).toBe('Removed **Mistake**.');
		expect(getOpenRecruits('g1')).toEqual([]);
	});

	it.each(['resolve', 'snooze', 'remove'])('%s says when the name is not open', async (subcommand) => {
		expect(await run(subcommand, { strings: { name: 'Nobody', outcome: 'left' }, integers: { days: 1 } })).toContain(
			'No open trial member named **Nobody**',
		);
	});
});

describe('/recruit list', () => {
	it('lists open entries, soonest first, with their state and note', async () => {
		const posted = addOpen('Posted', { dueAt: NOW - 2 * DAY_MS, note: 'asked about raids' });
		markRecruitReminded(posted.id, posted.due_at);
		addOpen('Later', { dueAt: NOW + 5 * DAY_MS });
		addOpen('Overdue', { dueAt: NOW - DAY_MS });
		setRecruitSettings('g1', { channelId: 'c1' });

		const reply = await run('list');

		expect(reply.split('\n')).toEqual([
			'**Open trial members (3):**',
			'',
			`**Posted** — followed up, waiting since <t:${seconds(NOW - 2 * DAY_MS)}:R> · added <t:${seconds(NOW)}:R> by <@mod1>`,
			'> asked about raids',
			`**Overdue** — follow-up overdue since <t:${seconds(NOW - DAY_MS)}:R> · added <t:${seconds(NOW)}:R> by <@mod1>`,
			`**Later** — follow-up <t:${seconds(NOW + 5 * DAY_MS)}:R> · added <t:${seconds(NOW)}:R> by <@mod1>`,
		]);
	});

	it('says when there are none, and why follow-ups are held back', async () => {
		const reply = await run('list');
		expect(reply).toContain('No open trial members');
		expect(reply).toContain('/recruit config channel:');
	});

	it('splits a long list into pages within Discord’s 2000 characters', async () => {
		for (let i = 0; i < 30; i++) addOpen(`Member ${String(i).padStart(2, '0')}`, { note: 'n'.repeat(250) });

		const first = await run('list');
		const pageCount = Number(/Page 1 of (\d+)/.exec(first)?.[1]);
		expect(pageCount).toBeGreaterThan(1);
		expect(first).toContain('`/recruit list page:2` for more.');

		const pages = [first];
		for (let page = 2; page <= pageCount; page++) pages.push(await run('list', { integers: { page } }));
		for (const page of pages) expect(page.length).toBeLessThanOrEqual(2000);
		// Every entry once, across the pages.
		expect(pages.join('').match(/\*\*Member \d+\*\*/g)).toHaveLength(30);
		expect(pages.at(-1)).toContain(`Page ${pageCount} of ${pageCount}.`);
		// A page past the end shows the last.
		expect(await run('list', { integers: { page: 99 } })).toBe(pages.at(-1));
	});
});

describe('/recruit config', () => {
	const channel = () => Object.assign(createMockGuildChannel(), { id: 'c1' });

	it('needs a channel first', async () => {
		expect(await run('config')).toContain('Not set up yet');
		expect(await run('config', { integers: { days: 10 } })).toContain('Pick a `channel`');
		expect(getRecruitSettings('g1')).toBeUndefined();
	});

	it('saves the channel, role and days, and shows them with no options', async () => {
		const role = { id: 'r1', mentionable: true, toString: () => '<@&r1>' };

		const reply = await run('config', { channels: { channel: channel() }, roles: { role }, integers: { days: 21 } });

		expect(getRecruitSettings('g1')).toMatchObject({ channel_id: 'c1', ping_role_id: 'r1', follow_up_days: 21 });
		expect(reply).toBe('Saved. Follow-ups go to <#c1>, pinging <@&r1>, 21 days after a trial member is added.');
		expect(await run('config')).toBe('Follow-ups go to <#c1>, pinging <@&r1>, 21 days after a trial member is added.');
	});

	it('keeps what is left out, and stops pinging with no_ping', async () => {
		setRecruitSettings('g1', { channelId: 'c1', pingRoleId: 'r1', followUpDays: 21 });

		await run('config', { integers: { days: 7 } });
		expect(getRecruitSettings('g1')).toMatchObject({ channel_id: 'c1', ping_role_id: 'r1', follow_up_days: 7 });

		expect(await run('config', { booleans: { no_ping: true } })).toContain('pinging no one');
		expect(getRecruitSettings('g1')?.ping_role_id).toBeNull();
	});

	it('refuses a role together with no_ping', async () => {
		expect(await run('config', { roles: { role: { id: 'r1' } }, booleans: { no_ping: true } })).toContain('not both');
	});

	it('shows a pause, and resumes when run again', async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		pauseRecruitFollowUps('g1', 'c1');
		expect(await run('config')).toContain('paused');

		await run('config', { channels: { channel: channel() } });

		expect(getRecruitSettings('g1')?.enabled).toBe(1);
	});

	it('warns, and still saves, when the bot cannot post in the channel', async () => {
		const blocked = Object.assign(
			createMockGuildChannel((p) => p !== PermissionFlagsBits.SendMessages),
			{ id: 'c1' },
		);

		const reply = await run('config', { channels: { channel: blocked } });

		expect(reply).toContain("I'm missing these permissions in that channel: Send Messages");
		expect(getRecruitSettings('g1')?.channel_id).toBe('c1');
	});

	it("warns when the role can't be mentioned by the bot, checking the saved channel", async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		const saved = Object.assign(
			createMockGuildChannel((p) => p !== PermissionFlagsBits.MentionEveryone),
			{ id: 'c1' },
		);
		const role = { id: 'r1', mentionable: false, toString: () => '<@&r1>' };

		const reply = await run('config', { roles: { role } }, createMockGuild({ channels: [saved], roles: [role] }));

		expect(reply).toContain("<@&r1> doesn't allow anyone to mention it");
		expect(getRecruitSettings('g1')?.ping_role_id).toBe('r1');

		// Mention Everyone covers it.
		const withMentionEveryone = Object.assign(createMockGuildChannel(), { id: 'c1' });
		expect(
			await run(
				'config',
				{ integers: { days: 9 } },
				createMockGuild({ channels: [withMentionEveryone], roles: [role] }),
			),
		).not.toContain('⚠️');
	});
});

describe('/recruit name autocomplete', () => {
	async function autocomplete(focused: string, inCachedGuild = true) {
		const interaction = createMockInteraction({
			isAutocomplete: true,
			isChatInputCommand: false,
			inCachedGuild,
			guild: createMockGuild(),
			focused,
		});
		await recruitCommand.autocomplete(interaction as never);
		return interaction.respond.mock.calls[0]?.[0] as { name: string; value: string }[];
	}

	it('offers open names, prefix matches first, each with when it is due', async () => {
		addOpen('Bob Alexson', { dueAt: NOW + DAY_MS });
		addOpen('Alex Le', { dueAt: NOW + 10 * DAY_MS - 1 });
		const posted = addOpen('Alexa', { dueAt: NOW - 1 });
		markRecruitReminded(posted.id, posted.due_at);
		addOpen('Zed', { dueAt: NOW - 1 });

		expect(await autocomplete(' ALEX')).toEqual([
			{ name: 'Alex Le · due in 10 days', value: 'Alex Le' },
			{ name: 'Alexa · followed up', value: 'Alexa' },
			{ name: 'Bob Alexson · due in 1 day', value: 'Bob Alexson' },
		]);
		expect(await autocomplete('zed')).toEqual([{ name: 'Zed · overdue', value: 'Zed' }]);
	});

	it('offers nothing outside a server', async () => {
		addOpen('Alex Le');
		expect(await autocomplete('', false)).toEqual([]);
	});
});
