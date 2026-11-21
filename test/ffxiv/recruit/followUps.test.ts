import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAPIError, RESTJSONErrorCodes, type MessageCreateOptions } from 'discord.js';
import { startScheduler, stopScheduler } from '../../../src/core/scheduler.ts';
import { recruitFollowUpCheck } from '../../../src/ffxiv/recruit/followUps.ts';
import {
	addRecruit,
	getOpenRecruitByName,
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

	it('stops the batch once shutdown aborts it', async () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		addDue('First');
		addDue('Second');
		const channel = createMockChannel();
		let finishSend: () => void = () => {};
		channel.send.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSend = resolve)));

		startScheduler([recruitFollowUpCheck(createMockClient({ channels: { c1: channel } }))]);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		const stopped = stopScheduler();
		finishSend();
		await stopped;

		expect(channel.send).toHaveBeenCalledTimes(1);
		expect(getOpenRecruitByName('g1', 'First')?.status).toBe('reminded');
		expect(getOpenRecruitByName('g1', 'Second')?.status).toBe('pending');
	});
});
