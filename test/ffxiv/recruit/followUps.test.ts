import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAPIError, RESTJSONErrorCodes, type MessageCreateOptions } from 'discord.js';
import { startScheduler, stopScheduler } from '../../../src/core/scheduler.ts';
import { recruitFollowUpCheck } from '../../../src/ffxiv/recruit/followUps.ts';
import {
	addRecruit,
	getOpenRecruitByName,
	getOpenRecruits,
	MAX_OPEN_RECRUITS_PER_GUILD,
	MAX_RECRUIT_NOTE_LENGTH,
	getRecruitSettings,
	setRecruitSettings,
	updateRecruit,
} from '../../../src/ffxiv/recruit/storage.ts';
import { __resetForTests } from '../../../src/core/database.ts';
import { createMockChannel, createMockClient } from '../../mocks.ts';

const POLL_MS = 60_000;

beforeEach(() => {
	__resetForTests();
	vi.useFakeTimers();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
	await stopScheduler();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function discordError(code: number, status: number): DiscordAPIError {
	return new DiscordAPIError({ message: 'mock', code }, code, status, 'POST', 'https://discord.com/api/v10/mock', {});
}

function addDue(name: string, overrides: { guildId?: string; note?: string } = {}) {
	return addRecruit({
		guildId: overrides.guildId ?? 'g1',
		name,
		note: overrides.note ?? '',
		addedBy: 'mod1',
		addedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
		dueAt: Date.now(),
	});
}

async function poll(client: ReturnType<typeof createMockClient>): Promise<void> {
	startScheduler([recruitFollowUpCheck(client)]);
	await vi.advanceTimersByTimeAsync(POLL_MS);
}

function sent(send: ReturnType<typeof createMockChannel>['send'], call = 0): MessageCreateOptions {
	return send.mock.calls[call]?.[0] as MessageCreateOptions;
}

describe('recruit follow-up check', () => {
	it('posts a due follow-up once, pinging only the configured role, and marks it reminded', async () => {
		setRecruitSettings('g1', { channelId: 'c1', pingRoleId: 'r1' });
		addDue('Alex Le', { note: 'met in Limsa <@123>' });
		const channel = createMockChannel();
		const client = createMockClient({ channels: { c1: channel } });

		startScheduler([recruitFollowUpCheck(client)]);
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);

		expect(channel.send).toHaveBeenCalledTimes(1);
		const message = sent(channel.send);
		expect(message.content).toMatch(
			/^<@&r1> \*\*Alex Le\*\* joined as a trial member <t:\d+:R> \(added by <@mod1>\)\./,
		);
		expect(message.content).toContain('> met in Limsa <@123>');
		expect(message.content).toContain('/recruit resolve');
		expect(message.allowedMentions).toEqual({ parse: [], roles: ['r1'] });
		expect(getOpenRecruitByName('g1', 'Alex Le')?.status).toBe('reminded');
	});

	it('pings no one without a role, and escapes markdown in the name', async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		addDue('Al_ex*');
		const channel = createMockChannel();

		await poll(createMockClient({ channels: { c1: channel } }));

		const message = sent(channel.send);
		expect(message.content).toMatch(/^\*\*Al\\_ex\\\*\*\* joined/);
		expect(message.content).not.toContain('\n>');
		expect(message.allowedMentions).toEqual({ parse: [], roles: [] });
	});

	it('posts nothing for a server without settings, or before the due date', async () => {
		addDue('Unconfigured', { guildId: 'g2' });
		setRecruitSettings('g1', { channelId: 'c1' });
		const later = addDue('Later');
		updateRecruit(later.id, { dueAt: Date.now() + 2 * POLL_MS });
		const channel = createMockChannel();
		const client = createMockClient({ channels: { c1: channel } });

		await poll(client);

		expect(client.channels.fetch).not.toHaveBeenCalled();
	});

	it('pauses the server, keeping its follow-ups pending, when the channel is gone', async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		addDue('First');
		addDue('Second');
		const client = createMockClient({ channels: {} });

		await poll(client);

		expect(getRecruitSettings('g1')?.enabled).toBe(0);
		// Once per server, not once per entry.
		expect(client.channels.fetch).toHaveBeenCalledTimes(1);
		expect(getOpenRecruitByName('g1', 'First')?.status).toBe('pending');
		expect(getOpenRecruitByName('g1', 'Second')?.status).toBe('pending');
	});

	it.each([
		['deleted', RESTJSONErrorCodes.UnknownChannel, 404],
		['missing permissions', RESTJSONErrorCodes.MissingPermissions, 403],
	])(
		'pauses the server when Discord refuses the post (%s), and posts once /recruit config resumes it',
		async (_, code, status) => {
			setRecruitSettings('g1', { channelId: 'c1' });
			addDue('Alex Le');
			const channel = createMockChannel();
			channel.send.mockRejectedValueOnce(discordError(code, status));
			const client = createMockClient({ channels: { c1: channel } });

			startScheduler([recruitFollowUpCheck(client)]);
			await vi.advanceTimersByTimeAsync(POLL_MS * 2);

			expect(channel.send).toHaveBeenCalledTimes(1);
			expect(getRecruitSettings('g1')?.enabled).toBe(0);
			expect(getOpenRecruitByName('g1', 'Alex Le')?.status).toBe('pending');

			setRecruitSettings('g1', {});
			await vi.advanceTimersByTimeAsync(POLL_MS);

			expect(channel.send).toHaveBeenCalledTimes(2);
			expect(getOpenRecruitByName('g1', 'Alex Le')?.status).toBe('reminded');
		},
	);

	it('retries on the next poll after a network or server error, without pausing', async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		addDue('Alex Le');
		const channel = createMockChannel();
		channel.send.mockRejectedValueOnce(new Error('ECONNRESET'));

		startScheduler([recruitFollowUpCheck(createMockClient({ channels: { c1: channel } }))]);
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);

		expect(channel.send).toHaveBeenCalledTimes(2);
		expect(getRecruitSettings('g1')?.enabled).toBe(1);
		expect(getOpenRecruitByName('g1', 'Alex Le')?.status).toBe('reminded');
	});

	it("keeps posting another server's follow-ups when one server fails", async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		setRecruitSettings('g2', { channelId: 'c2' });
		addDue('Broken');
		addDue('Fine', { guildId: 'g2' });
		const good = createMockChannel();

		await poll(createMockClient({ channels: { c1: createMockChannel({ sendable: false }), c2: good } }));

		expect(getRecruitSettings('g1')?.enabled).toBe(0);
		expect(good.send).toHaveBeenCalledTimes(1);
		expect(getOpenRecruitByName('g2', 'Fine')?.status).toBe('reminded');
	});

	it('leaves a snooze made during the post standing', async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		const recruit = addDue('Alex Le');
		const channel = createMockChannel();
		channel.send.mockImplementationOnce(() => {
			updateRecruit(recruit.id, { dueAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
			return Promise.resolve({});
		});

		await poll(createMockClient({ channels: { c1: channel } }));

		expect(getOpenRecruitByName('g1', 'Alex Le')?.status).toBe('pending');
	});

	it('stops the batch between servers once shutdown aborts it', async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		setRecruitSettings('g2', { channelId: 'c2' });
		addDue('First');
		addDue('Second', { guildId: 'g2' });
		const first = createMockChannel();
		const second = createMockChannel();
		let finishSend: () => void = () => {};
		first.send.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSend = resolve)));

		startScheduler([recruitFollowUpCheck(createMockClient({ channels: { c1: first, c2: second } }))]);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		const stopped = stopScheduler();
		finishSend();
		await stopped;

		expect(getOpenRecruitByName('g1', 'First')?.status).toBe('reminded');
		expect(second.send).not.toHaveBeenCalled();
		expect(getOpenRecruitByName('g2', 'Second')?.status).toBe('pending');
	});

	it("posts a server's due follow-ups together, pinging once", async () => {
		setRecruitSettings('g1', { channelId: 'c1', pingRoleId: 'r1' });
		addDue('First');
		addDue('Second', { note: 'line one\n  line two' });
		const channel = createMockChannel();

		await poll(createMockClient({ channels: { c1: channel } }));

		expect(channel.send).toHaveBeenCalledTimes(1);
		const { content } = sent(channel.send);
		expect(content?.match(/<@&r1>/g)).toHaveLength(1);
		expect(content).toContain('**First** joined');
		expect(content).toContain('**Second** joined');
		// A line break in a note would end the quote.
		expect(content).toContain('> line one line two');
		expect(content).not.toContain('more in the next post');
		expect(getOpenRecruitByName('g1', 'Second')?.status).toBe('reminded');
	});

	it('spreads a backlog over posts within 2000 characters, one per poll', async () => {
		setRecruitSettings('g1', { channelId: 'c1', pingRoleId: 'r1' });
		for (let i = 0; i < MAX_OPEN_RECRUITS_PER_GUILD; i++) {
			addDue(`Member ${String(i).padStart(3, '0')} ${'x'.repeat(30)}`, { note: 'n'.repeat(MAX_RECRUIT_NOTE_LENGTH) });
		}
		const channel = createMockChannel();

		startScheduler([recruitFollowUpCheck(createMockClient({ channels: { c1: channel } }))]);
		await vi.advanceTimersByTimeAsync(POLL_MS);

		expect(channel.send).toHaveBeenCalledTimes(1);
		const first = sent(channel.send).content!;
		expect(first.length).toBeLessThanOrEqual(2000);
		const shown = first.match(/\*\*Member \d+/g)!.length;
		expect(first).toContain(`…and ${MAX_OPEN_RECRUITS_PER_GUILD - shown} more in the next post.`);
		expect(getOpenRecruits('g1').filter((r) => r.status === 'reminded')).toHaveLength(shown);

		// Every entry posted exactly once, over as many polls as it takes.
		await vi.advanceTimersByTimeAsync(POLL_MS * MAX_OPEN_RECRUITS_PER_GUILD);
		const posts = channel.send.mock.calls.map(([options]) => (options as MessageCreateOptions).content!);
		for (const post of posts) expect(post.length).toBeLessThanOrEqual(2000);
		expect(posts.join('').match(/\*\*Member \d+/g)).toHaveLength(MAX_OPEN_RECRUITS_PER_GUILD);
		expect(getOpenRecruits('g1').every((r) => r.status === 'reminded')).toBe(true);
	});
});
