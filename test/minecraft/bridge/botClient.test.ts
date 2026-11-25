import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetForTests } from '../../../src/core/database.ts';
import { createApp } from '../../../src/dashboard/app.ts';
import {
	MAX_BACKOFF_MS,
	MIN_EMPTY_POLL_GAP_MS,
	REPORT_DEADLINE_MS,
	createBotClient,
	type BotChat,
	type BotClient,
	type StopReason,
} from '../../../src/minecraft/bridge/botClient.ts';
import {
	deriveKeys,
	newBridgeSecret,
	open,
	parseEnvelope,
	seal,
	type Envelope,
} from '../../../src/minecraft/bridge/seal.ts';
import { HelperHub } from '../../../src/minecraft/helperHub.ts';
import { LinkCodes } from '../../../src/minecraft/linking.ts';
import { createBridge, getLink } from '../../../src/minecraft/storage.ts';

const URL_BASE = 'http://127.0.0.1:3000/minecraft/';

let client: BotClient | null = null;

beforeEach(() => {
	__resetForTests();
});

afterEach(async () => {
	await client?.stop();
	client = null;
	vi.useRealTimers();
});

function start(options: Parameters<typeof createBotClient>[0]) {
	client = createBotClient(options);
	client.start();
	return client;
}

describe("the helper's connection, against the bot's real endpoint", () => {
	it('connects, hands over the chat the bot queues, and stops a held poll at once', async () => {
		const secret = newBridgeSecret();
		const bridge = createBridge({
			guildId: 'g1',
			chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
			alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
			keys: deriveKeys(secret),
			serverName: 'Survival',
			now: Date.now(),
		});
		const hub = new HelperHub();
		const app = createApp({ auth: null, helpers: hub });
		// As fetch: a request whose signal aborts rejects, as Node's fetch does.
		const viaApp: typeof fetch = (input, init) =>
			new Promise((resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				const headers = { ...(init?.headers as Record<string, string>), 'cf-connecting-ip': '203.0.113.9' };
				Promise.resolve(app.request(String(input), { ...init, headers })).then(resolve, reject);
			});
		const received: BotChat[] = [];
		const log = vi.fn();

		start({
			bot: { url: URL_BASE, bridge: bridge.id, secret },
			onChat: (chat) => received.push(...chat),
			onStopped: vi.fn(),
			fetch: viaApp,
			log,
		});
		await vi.waitFor(() => expect(hub.__isPollHeldForTests(bridge.id)).toBe(true));
		hub.deliver(bridge.id, { kind: 'chat', name: 'Alex', text: 'hi' });
		await vi.waitFor(() => expect(received).toEqual([{ kind: 'chat', name: 'Alex', text: 'hi' }]));

		await vi.waitFor(() => expect(hub.__isPollHeldForTests(bridge.id)).toBe(true));
		const stopping = Date.now();
		await client!.stop();
		expect(Date.now() - stopping).toBeLessThan(1000);
		expect(log).toHaveBeenCalledWith('connected to the bot');
	});
});

// A fake bot answering each request with the next scripted reply, sealed as
// the real one seals them, so each kind of answer can be tried on its own.
const BRIDGE = 'AAECAwQFBgcICQoLDA0ODw';
type Reply =
	| { status: number; sealed: unknown; botTime?: number; keys?: ReturnType<typeof deriveKeys> }
	| { status: number; plain: string; headers?: Record<string, string> }
	| { fail: true };

function scriptedBot(replies: Reply[]) {
	const secret = newBridgeSecret();
	const keys = deriveKeys(secret);
	const requests: { route: string; message: unknown; sentAt: number; at: number }[] = [];
	const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
		const route = String(input).slice(URL_BASE.length);
		const envelope = parseEnvelope(JSON.parse(String(init!.body))) as Envelope;
		const opened = open(keys, 'request', { bridgeId: BRIDGE, route }, envelope);
		if (!opened.ok) throw new Error('the client sent something that did not open');
		requests.push({ route, message: opened.message, sentAt: opened.sentAt, at: Date.now() });
		const reply = replies.shift();
		// Past the script, a held poll, as the real bot's: answering at once
		// would have the client poll in a loop that never lets timers run.
		if (!reply) {
			return new Promise<Response>((_, reject) =>
				init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
			);
		}
		if ('fail' in reply) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
		if ('plain' in reply) return new Response(reply.plain, { status: reply.status, headers: reply.headers ?? {} });
		const answer = seal(
			reply.keys ?? keys,
			'response',
			{ bridgeId: BRIDGE, route, replyTo: envelope.iv },
			reply.sealed,
			reply.botTime ?? Date.now(),
		);
		return new Response(JSON.stringify(answer), {
			status: reply.status,
			headers: { 'content-type': 'application/json' },
		});
	});
	return { bot: { url: URL_BASE, bridge: BRIDGE, secret }, fetchFn, requests };
}

const connected: Reply = { status: 200, sealed: { session: 's1' } };

function startScripted(
	replies: Reply[],
	extra: {
		url?: string;
		requestTimeoutMs?: number;
		onChat?: (chat: BotChat[]) => void;
		onSettings?: (settings: unknown) => void;
	} = {},
) {
	const scripted = scriptedBot(replies);
	const onChat = vi.fn<(chat: BotChat[]) => void>(extra.onChat);
	const onStopped = vi.fn<(reason: StopReason) => void>();
	const log = vi.fn();
	start({
		bot: { ...scripted.bot, url: extra.url ?? scripted.bot.url },
		onChat,
		onStopped,
		fetch: scripted.fetchFn,
		log,
		...(extra.onSettings ? { onSettings: extra.onSettings } : {}),
		...(extra.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: extra.requestTimeoutMs }),
	});
	return { ...scripted, onChat, onStopped, log };
}

describe("the helper's connection, answer by answer", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_790_000_000_000 });
	});

	it('polls with its session, passing on chat and skipping kinds it does not know', async () => {
		const { requests, onChat } = startScripted([
			connected,
			{
				status: 200,
				sealed: { messages: [{ kind: 'chat', name: 'Alex', text: 'hi' }, { kind: 'newer-thing' }, { kind: 'chat' }] },
			},
		]);
		await vi.advanceTimersByTimeAsync(0);

		expect(requests.slice(0, 3).map((r) => [r.route, r.message])).toEqual([
			['connect', {}],
			['poll', { session: 's1' }],
			['poll', { session: 's1' }],
		]);
		expect(onChat).toHaveBeenCalledExactlyOnceWith([{ kind: 'chat', name: 'Alex', text: 'hi' }]);
	});

	it('connects again when the session ended (410)', async () => {
		const { requests } = startScripted([connected, { status: 410, sealed: { error: 'session-ended' } }]);
		await vi.advanceTimersByTimeAsync(0);

		expect(requests.slice(0, 3).map((r) => r.route)).toEqual(['connect', 'poll', 'connect']);
	});

	it('stops for good when another helper took over (409), or the secret no longer works (401)', async () => {
		const takenOver = startScripted([connected, { status: 409, sealed: { error: 'taken-over' } }]);
		await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS * 2);
		expect(takenOver.onStopped).toHaveBeenCalledExactlyOnceWith('taken-over');
		expect(takenOver.requests).toHaveLength(2);
		await client!.stop();

		const refused = startScripted([{ status: 401, plain: '{"error":"unauthorized"}' }]);
		await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS * 2);
		expect(refused.onStopped).toHaveBeenCalledExactlyOnceWith('unauthorized');
		expect(refused.requests).toHaveLength(1);
	});

	it("doesn't stop for a 409 that isn't sealed by the bot: anyone on the way could send one", async () => {
		const other = deriveKeys(newBridgeSecret());
		const { onStopped, log } = startScripted([
			connected,
			{ status: 409, sealed: { error: 'taken-over' }, keys: other },
		]);
		await vi.advanceTimersByTimeAsync(0);

		expect(onStopped).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"the bot couldn't be reached (an answer that didn't open (HTTP 409)); trying again in 1 s",
		);
	});

	it("corrects for its clock when the bot refuses its time, sealing the next request in the bot's time", async () => {
		const botTime = Date.now() + 10 * 60_000;
		const { requests } = startScripted([{ status: 400, sealed: { error: 'clock' }, botTime }, connected]);
		await vi.advanceTimersByTimeAsync(0);

		expect(requests[1]!.route).toBe('connect');
		expect(Math.abs(requests[1]!.sentAt - botTime)).toBeLessThan(1000);
	});

	it('backs off after failures, 1 s doubling to 60 s, and starts over once answered', async () => {
		const failures: Reply[] = Array.from({ length: 8 }, () => ({ fail: true }));
		const { requests } = startScripted([...failures, connected, { fail: true }]);
		await vi.advanceTimersByTimeAsync(10 * 60_000);

		const gaps = requests.slice(1, 11).map((r, i) => r.at - requests[i]!.at);
		expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 0, 1000]);
	});

	it("treats an unsealed error page as a failure, and waits out a 429's Retry-After", async () => {
		const { requests, log } = startScripted([
			{ status: 502, plain: '<html>Bad gateway</html>' },
			{ status: 429, plain: '{"error":"rate-limited"}', headers: { 'Retry-After': '7' } },
			connected,
		]);
		await vi.advanceTimersByTimeAsync(20_000);

		expect(log).toHaveBeenCalledWith("the bot couldn't be reached (HTTP 502); trying again in 1 s");
		expect(requests[2]!.at - requests[1]!.at).toBe(7000);
	});

	it('stops at once while waiting to try again', async () => {
		const { requests } = startScripted([{ fail: true }]);
		await vi.advanceTimersByTimeAsync(0);

		await client!.stop();
		await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS * 2);

		expect(requests).toHaveLength(1);
	});

	it('keeps the configured path when the address has no trailing slash', async () => {
		const { fetchFn } = startScripted([connected], { url: URL_BASE.slice(0, -1) });
		await vi.advanceTimersByTimeAsync(0);

		expect(String(fetchFn.mock.calls[0]![0])).toBe(`${URL_BASE}connect`);
	});

	it('keeps polling when handling chat throws, logging it', async () => {
		const { requests, log } = startScripted(
			[connected, { status: 200, sealed: { messages: [{ kind: 'chat', name: 'A', text: 'b' }] } }],
			{
				onChat: () => {
					throw new Error('tellraw broke');
				},
			},
		);
		await vi.advanceTimersByTimeAsync(0);

		expect(log).toHaveBeenCalledWith('handling chat from the bot failed: tellraw broke');
		expect(requests).toHaveLength(3);
	});

	it('backs off when a connect is answered without a session', async () => {
		const { requests, log } = startScripted([{ status: 200, sealed: {} }, connected]);
		await vi.advanceTimersByTimeAsync(5000);

		expect(log).toHaveBeenCalledWith("the bot's answer had no session; trying again in 1 s");
		expect(requests[1]!.at - requests[0]!.at).toBe(1000);
	});

	it(`leaves ${MIN_EMPTY_POLL_GAP_MS / 1000} s between polls answered at once with nothing, as while the bot closes`, async () => {
		const empty: Reply = { status: 200, sealed: { messages: [] } };
		const { requests } = startScripted([connected, empty, empty]);
		await vi.advanceTimersByTimeAsync(5000);

		expect(requests[2]!.at - requests[1]!.at).toBe(MIN_EMPTY_POLL_GAP_MS);
		expect(requests[3]!.at - requests[2]!.at).toBe(MIN_EMPTY_POLL_GAP_MS);
	});

	it('backs off on a 403, which Cloudflare can send for a moment, rather than stopping', async () => {
		const { requests, onStopped } = startScripted([{ status: 403, plain: '<html>Forbidden</html>' }, connected]);
		await vi.advanceTimersByTimeAsync(5000);

		expect(onStopped).not.toHaveBeenCalled();
		expect(requests.map((r) => r.route).slice(0, 2)).toEqual(['connect', 'connect']);
	});

	it('gives up on a request with no answer in time, and backs off', async () => {
		const { log } = startScripted([connected], { requestTimeoutMs: 5000 });
		await vi.advanceTimersByTimeAsync(5000);

		expect(log).toHaveBeenCalledWith("the bot couldn't be reached (no answer in time); trying again in 1 s");
	});

	it('backs off when the bot refuses its time twice in a row, rather than looping', async () => {
		const clock: Reply = { status: 400, sealed: { error: 'clock' }, botTime: Date.now() };
		const { requests } = startScripted([clock, clock, connected]);
		await vi.advanceTimersByTimeAsync(5000);

		expect(requests[1]!.at - requests[0]!.at).toBe(0);
		expect(requests[2]!.at - requests[1]!.at).toBe(1000);
	});

	it(`waits ${MAX_BACKOFF_MS / 1000} s after a 429 without Retry-After`, async () => {
		const { requests } = startScripted([{ status: 429, plain: '{"error":"rate-limited"}' }, connected]);
		await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS * 2);

		expect(requests[1]!.at - requests[0]!.at).toBe(MAX_BACKOFF_MS);
	});

	it("hands on the settings from the connect answer and the latest in a poll, and doesn't wait after a settings-only answer", async () => {
		const onSettings = vi.fn();
		const settings = (serverName: string) => ({ kind: 'settings', serverName });
		const { requests } = startScripted(
			[
				{ status: 200, sealed: { session: 's1', settings: settings('A') } },
				{ status: 200, sealed: { messages: [settings('B'), { kind: 'chat', name: 'x', text: 'y' }, settings('C')] } },
				{ status: 200, sealed: { messages: [settings('D')] } },
			],
			{ onSettings },
		);
		await vi.advanceTimersByTimeAsync(0);

		expect(onSettings.mock.calls.map((call) => (call[0] as { serverName: string }).serverName)).toEqual([
			'A',
			'C',
			'D',
		]);
		expect(requests).toHaveLength(4);
	});

	it('keeps polling when applying settings throws, logging it', async () => {
		const { requests, log } = startScripted([{ status: 200, sealed: { session: 's1', settings: {} } }], {
			onSettings: () => {
				throw new Error('bad');
			},
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(log).toHaveBeenCalledWith('applying the bridge settings failed: bad');
		expect(requests).toHaveLength(2);
	});
});

describe("a player's `!link` report", () => {
	const MOJANG_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
	const steve = { player: 'Steve', code: '123456', uuid: MOJANG_UUID, onlineMode: true };

	// Not started: a report goes beside the poll loop, so the script holds only its replies.
	function reporter(replies: Reply[]) {
		const scripted = scriptedBot(replies);
		const log = vi.fn();
		const reporting = createBotClient({
			bot: scripted.bot,
			onChat: vi.fn(),
			onStopped: vi.fn(),
			fetch: scripted.fetchFn,
			log,
		});
		client = reporting;
		return { ...scripted, client: reporting, log };
	}

	it("links against the bot's real endpoint, the answer worded by the bot", async () => {
		const secret = newBridgeSecret();
		const bridge = createBridge({
			guildId: 'g1',
			chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
			alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
			keys: deriveKeys(secret),
			serverName: 'Survival',
			now: Date.now(),
		});
		const linkCodes = new LinkCodes();
		const app = createApp({ auth: null, linkCodes });
		const viaApp: typeof fetch = (input, init) =>
			Promise.resolve(
				app.request(String(input), {
					...init,
					headers: { ...(init?.headers as Record<string, string>), 'cf-connecting-ip': '203.0.113.9' },
				}),
			);
		const code = linkCodes.issue(bridge.id, 'Steve', 'u1');
		const reporting = createBotClient({
			bot: { url: URL_BASE, bridge: bridge.id, secret },
			onChat: vi.fn(),
			onStopped: vi.fn(),
			fetch: viaApp,
		});
		client = reporting;

		// As bridge.ts sends it: a missed login line is an undefined UUID.
		await expect(reporting.report({ ...steve, code, uuid: undefined })).resolves.toMatchObject({
			result: 'log-in-again',
		});
		await expect(reporting.report({ ...steve, code })).resolves.toEqual({
			result: 'linked',
			text: 'Linked Steve to your Discord account. Choose your picture in the dashboard.',
		});
		expect(getLink(bridge.id, 'Steve')).toMatchObject({ user_id: 'u1', uuid: MOJANG_UUID });
	});

	describe('answer by answer', () => {
		beforeEach(() => {
			vi.useFakeTimers({ now: 1_790_000_000_000 });
		});

		it('sends the report sealed to `link`, with no session', async () => {
			const { client, requests } = reporter([{ status: 200, sealed: { result: 'linked', text: 'Linked.' } }]);

			await expect(client.report(steve)).resolves.toEqual({ result: 'linked', text: 'Linked.' });
			expect(requests.map((r) => [r.route, r.message])).toEqual([['link', steve]]);
		});

		it("waits out a 429's Retry-After, as reports share the bridge's limit with polls", async () => {
			const { client, requests } = reporter([
				{ status: 429, plain: '{"error":"rate-limited"}', headers: { 'Retry-After': '7' } },
				{ status: 200, sealed: { result: 'linked', text: 'Linked.' } },
			]);

			const answer = client.report(steve);
			await vi.advanceTimersByTimeAsync(7000);

			await expect(answer).resolves.toMatchObject({ result: 'linked' });
			expect(requests[1]!.at - requests[0]!.at).toBe(7000);
		});

		it("corrects for its clock once, then gives up if it's still refused", async () => {
			const botTime = Date.now() + 10 * 60_000;
			const fixed = reporter([
				{ status: 400, sealed: { error: 'clock' }, botTime },
				{ status: 200, sealed: { result: 'linked', text: 'Linked.' } },
			]);
			await expect(fixed.client.report(steve)).resolves.toMatchObject({ result: 'linked' });
			expect(Math.abs(fixed.requests[1]!.sentAt - botTime)).toBeLessThan(1000);
			await fixed.client.stop();

			const jumping = reporter([
				{ status: 400, sealed: { error: 'clock' }, botTime },
				{ status: 400, sealed: { error: 'clock' }, botTime: botTime + 10 * 60_000 },
			]);
			await expect(jumping.client.report(steve)).resolves.toBeNull();
			expect(jumping.log).toHaveBeenCalledWith("couldn't check Steve's !link with the bot (its clock keeps moving)");
		});

		it('backs off while the bot is out of reach, then gives up after a minute', async () => {
			const { client, requests, log } = reporter(Array.from({ length: 10 }, (): Reply => ({ fail: true })));

			const answer = client.report(steve);
			await vi.advanceTimersByTimeAsync(REPORT_DEADLINE_MS);

			await expect(answer).resolves.toBeNull();
			// 1, 2, 4, 8 and 16 s apart; the next wait, 32 s, would pass the minute.
			expect(requests).toHaveLength(6);
			expect(log).toHaveBeenCalledWith("couldn't check Steve's !link with the bot (no answer in time)");
		});

		it("doesn't send again what the bot refused, nor after a 401", async () => {
			const refused = reporter([{ status: 400, sealed: { error: 'bad-request' } }]);
			await expect(refused.client.report(steve)).resolves.toBeNull();
			expect(refused.requests).toHaveLength(1);
			expect(refused.log).toHaveBeenCalledWith("couldn't check Steve's !link with the bot (HTTP 400 bad-request)");
			await refused.client.stop();

			const unauthorized = reporter([{ status: 401, plain: '{"error":"unauthorized"}' }]);
			await expect(unauthorized.client.report(steve)).resolves.toBeNull();
			expect(unauthorized.requests).toHaveLength(1);
		});

		it('takes an answer without text as none', async () => {
			const { client } = reporter([{ status: 200, sealed: { result: 'linked' } }]);
			await expect(client.report(steve)).resolves.toBeNull();
		});

		it('gives up a report under way, or waiting to try again, when stopped', async () => {
			const held = reporter([]);
			const waiting = held.client.report(steve);
			await vi.advanceTimersByTimeAsync(0);
			await held.client.stop();
			await expect(waiting).resolves.toBeNull();

			const backingOff = reporter([{ fail: true }]);
			const answer = backingOff.client.report(steve);
			await vi.advanceTimersByTimeAsync(0);
			await backingOff.client.stop();
			await expect(answer).resolves.toBeNull();
			await expect(backingOff.client.report(steve)).resolves.toBeNull();
			expect(backingOff.requests).toHaveLength(1);
		});
	});
});
