import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/dashboard/app.ts';
import { __resetForTests } from '../../src/core/database.ts';
import {
	type Envelope,
	MAX_CLOCK_SKEW_MS,
	deriveKeys,
	newBridgeSecret,
	open,
	seal,
} from '../../src/minecraft/bridge/seal.ts';
import { HelperHub } from '../../src/minecraft/helperHub.ts';
import {
	BRIDGE_REQUESTS_PER_MINUTE,
	HELPER_VISITOR_REQUESTS_PER_MINUTE,
	MAX_REQUEST_BYTES,
} from '../../src/minecraft/helperRoutes.ts';
import { type BridgeKeys, createBridge } from '../../src/minecraft/storage.ts';

const STARTED = 1_790_000_000_000;
const ADDRESS = '203.0.113.5';
let time = STARTED;
const now = () => time;

beforeEach(() => {
	__resetForTests();
	time = STARTED;
});

afterEach(() => {
	vi.restoreAllMocks();
});

function pairedBridge(keys: BridgeKeys = deriveKeys(newBridgeSecret())) {
	const bridge = createBridge({
		guildId: 'g1',
		chat: { channelId: 'chat', webhookId: 'wh-chat', token: 'tok-chat' },
		alerts: { channelId: 'alerts', webhookId: 'wh-alerts', token: 'tok-alerts' },
		keys,
		serverName: 'Survival',
		now: time,
	});
	return { id: bridge.id, keys };
}

function setup() {
	const hub = new HelperHub(now);
	const app = createApp({ auth: null, now, helpers: hub });
	return { hub, app };
}

type App = ReturnType<typeof setup>['app'];

function post(app: App, route: string, body: string, headers: Record<string, string> = {}) {
	return app.request(`/minecraft/${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cf-connecting-ip': ADDRESS, ...headers },
		body,
	});
}

/** As the helper does: seals the message, sends it, and opens the sealed answer. */
async function call(
	app: App,
	bridge: { id: string; keys: BridgeKeys },
	route: string,
	message: unknown,
	sentAt = time,
	signal?: AbortSignal,
) {
	const request = seal(bridge.keys, 'request', { bridgeId: bridge.id, route }, message, sentAt);
	const response = await app.request(`/minecraft/${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cf-connecting-ip': ADDRESS },
		body: JSON.stringify(request),
		signal: signal ?? null,
	});
	const body = (await response.json()) as Envelope;
	const opened = open(bridge.keys, 'response', { bridgeId: bridge.id, route, replyTo: request.iv }, body);
	if (!opened.ok) throw new Error(`answer didn't open: ${opened.reason}`);
	return { status: response.status, message: opened.message, sentAt: opened.sentAt, request, body };
}

async function connect(app: App, bridge: { id: string; keys: BridgeKeys }): Promise<string> {
	const { status, message } = await call(app, bridge, 'connect', {});
	expect(status).toBe(200);
	return (message as { session: string }).session;
}

describe("the Minecraft helper's endpoint", () => {
	it('connects, then hands over the messages waiting, sealed as the answer to that poll', async () => {
		const { hub, app } = setup();
		const bridge = pairedBridge();
		const session = await connect(app, bridge);
		hub.deliver(bridge.id, { kind: 'chat', name: 'Alex', text: 'hi' });

		const answer = await call(app, bridge, 'poll', { session });

		expect(answer.status).toBe(200);
		expect(answer.message).toEqual({ messages: [{ kind: 'chat', name: 'Alex', text: 'hi' }] });
		// Sealed with the bot's time, and bound to the request it answers.
		expect(answer.sentAt).toBe(time);
		const other = seal(bridge.keys, 'request', { bridgeId: bridge.id, route: 'poll' }, { session }, time);
		expect(
			open(bridge.keys, 'response', { bridgeId: bridge.id, route: 'poll', replyTo: other.iv }, answer.body),
		).toEqual({ ok: false, reason: 'forged' });
	});

	it('holds a poll until a message comes', async () => {
		const { hub, app } = setup();
		const bridge = pairedBridge();
		const session = await connect(app, bridge);

		const answer = call(app, bridge, 'poll', { session });
		await vi.waitFor(() => expect(hub.__isPollHeldForTests(bridge.id)).toBe(true));
		hub.deliver(bridge.id, 'late');

		await expect(answer).resolves.toMatchObject({ status: 200, message: { messages: ['late'] } });
	});

	it('leaves a message for the next poll when the helper hangs up on a held one', async () => {
		const { hub, app } = setup();
		const bridge = pairedBridge();
		const session = await connect(app, bridge);
		const controller = new AbortController();

		const abandoned = call(app, bridge, 'poll', { session }, time, controller.signal);
		await vi.waitFor(() => expect(hub.__isPollHeldForTests(bridge.id)).toBe(true));
		controller.abort();
		await vi.waitFor(() => expect(hub.__isPollHeldForTests(bridge.id)).toBe(false));
		await abandoned.catch(() => {});
		hub.deliver(bridge.id, 'kept');

		await expect(call(app, bridge, 'poll', { session })).resolves.toMatchObject({ message: { messages: ['kept'] } });
	});

	it('answers a taken-over helper 409 and an ended session 410, both sealed', async () => {
		const { app } = setup();
		const bridge = pairedBridge();
		const old = await connect(app, bridge);
		await connect(app, bridge);

		await expect(call(app, bridge, 'poll', { session: old })).resolves.toMatchObject({
			status: 409,
			message: { error: 'taken-over' },
		});
		await expect(call(app, bridge, 'poll', { session: 'unknown' })).resolves.toMatchObject({
			status: 409,
		});

		const fresh = setup();
		const restarted = await call(fresh.app, bridge, 'poll', { session: old });
		expect(restarted).toMatchObject({ status: 410, message: { error: 'session-ended' } });
	});

	it.each([
		['connect', 'not an object'],
		['connect', null],
		['poll', {}],
		['poll', { session: 42 }],
		['poll', ['session']],
	])('answers %s with %j 400, sealed', async (route, message) => {
		const { app } = setup();
		const bridge = pairedBridge();

		await expect(call(app, bridge, route, message)).resolves.toMatchObject({
			status: 400,
			message: { error: 'bad-request' },
		});
	});

	describe('refused before the seal opens, in the clear', () => {
		it('answers an unknown bridge and a forged seal alike, 401', async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			const stranger = { id: 'BBBBBBBBBBBBBBBBBBBBBB', keys: bridge.keys };
			const forger = { id: bridge.id, keys: deriveKeys(newBridgeSecret()) };

			for (const who of [stranger, forger]) {
				const body = JSON.stringify(seal(who.keys, 'request', { bridgeId: who.id, route: 'connect' }, {}, time));
				const response = await post(app, 'connect', body);
				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({ error: 'unauthorized' });
			}
		});

		it('refuses a body sealed for another route', async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			const forConnect = seal(bridge.keys, 'request', { bridgeId: bridge.id, route: 'connect' }, {}, time);

			const response = await post(app, 'poll', JSON.stringify(forConnect));

			expect(response.status).toBe(401);
		});

		it('refuses a sealed answer sent back as a request', async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			const answer = seal(bridge.keys, 'response', { bridgeId: bridge.id, route: 'connect' }, {}, time);

			expect((await post(app, 'connect', JSON.stringify(answer))).status).toBe(401);
		});

		it.each([
			['text that is not JSON', 'not json'],
			['JSON that is not an envelope', JSON.stringify({ hello: 'there' })],
			['an envelope of another version', JSON.stringify({ v: 2, bridge: 'AAAAAAAAAAAAAAAAAAAAAA', iv: '', box: '' })],
		])('answers %s 400', async (_, body) => {
			const { app } = setup();

			const response = await post(app, 'connect', body);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'malformed' });
		});

		it('takes JSON only', async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			const body = JSON.stringify(seal(bridge.keys, 'request', { bridgeId: bridge.id, route: 'connect' }, {}, time));

			// Hono's CSRF check answers form-like types first (403); anything else gets 415 here.
			const response = await post(app, 'connect', body, { 'content-type': 'application/xml' });

			expect(response.status).toBe(415);
		});

		it('refuses a body over MAX_REQUEST_BYTES by its Content-Length', async () => {
			const { app } = setup();

			const response = await post(app, 'connect', 'x'.repeat(MAX_REQUEST_BYTES + 1));

			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({ error: 'too-large' });
		});

		it('stops reading a body sent without a length once it passes MAX_REQUEST_BYTES', async () => {
			const { app } = setup();
			let chunksRead = 0;
			const chunk = new Uint8Array(1024);
			const endless = new ReadableStream<Uint8Array>({
				pull(controller) {
					chunksRead++;
					controller.enqueue(chunk);
				},
			});

			const response = await app.request('/minecraft/connect', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
				body: endless,
				duplex: 'half',
			} as RequestInit);

			expect(response.status).toBe(413);
			expect(chunksRead).toBeLessThan(MAX_REQUEST_BYTES / 1024 + 5);
		});

		it('refuses a replayed request', async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			const body = JSON.stringify(seal(bridge.keys, 'request', { bridgeId: bridge.id, route: 'connect' }, {}, time));
			expect((await post(app, 'connect', body)).status).toBe(200);

			const again = await post(app, 'connect', body);

			expect(again.status).toBe(400);
			expect(await again.json()).toEqual({ error: 'replayed' });
		});
	});

	describe('a helper whose clock is off', () => {
		it('gets the bot’s time, sealed, so it can correct for it', async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			time += 10 * 60_000;

			const answer = await call(app, bridge, 'connect', {}, time - MAX_CLOCK_SKEW_MS - 1);

			expect(answer).toMatchObject({ status: 400, message: { error: 'clock' }, sentAt: time });
		});

		it('is refused for anything sealed before the bot started, so a capture can’t be replayed after a deploy', async () => {
			const { app } = setup();
			const bridge = pairedBridge();

			const answer = await call(app, bridge, 'connect', {}, STARTED - 1);

			expect(answer).toMatchObject({ status: 400, message: { error: 'clock' } });
		});
	});

	describe('rate limits', () => {
		it('limits each bridge before looking it up, answering with Retry-After', async () => {
			const { app } = setup();
			const unknown = JSON.stringify({
				v: 1,
				bridge: 'CCCCCCCCCCCCCCCCCCCCCC',
				iv: 'AAAAAAAAAAAAAAAA',
				box: 'A'.repeat(22),
			});
			for (let i = 0; i < BRIDGE_REQUESTS_PER_MINUTE; i++) {
				expect((await post(app, 'poll', unknown, { 'cf-connecting-ip': `198.51.100.${i % 200}` })).status).toBe(401);
			}

			const limited = await post(app, 'poll', unknown, { 'cf-connecting-ip': '192.0.2.1' });

			expect(limited.status).toBe(429);
			expect(limited.headers.get('retry-after')).toBe('60');
			// Another bridge isn't held back by it.
			const bridge = pairedBridge();
			expect((await call(app, bridge, 'connect', {})).status).toBe(200);
		});

		it('limits each address before reading anything', async () => {
			const { app } = setup();
			for (let i = 0; i < HELPER_VISITOR_REQUESTS_PER_MINUTE; i++) {
				expect((await post(app, 'connect', 'not json')).status).toBe(400);
			}

			const limited = await post(app, 'connect', 'not json');

			expect(limited.status).toBe(429);
			expect(await limited.json()).toEqual({ error: 'rate-limited' });
			time += 60_000;
			expect((await post(app, 'connect', 'not json')).status).toBe(400);
		});

		it('doesn’t count the helper’s requests against the pages’ limit for that address', async () => {
			const { app } = setup();
			for (let i = 0; i < 100; i++) await post(app, 'connect', 'not json');

			const page = await app.request('/', { headers: { 'cf-connecting-ip': ADDRESS } });

			expect(page.status).toBe(200);
		});
	});

	describe("the relay's announcement", () => {
		it('asks the announcer on each sealed request, connect and poll alike, and never on a forged one', async () => {
			const ensure = vi.fn(() => Promise.resolve());
			const app = createApp({
				auth: null,
				now,
				helpers: new HelperHub(now),
				announcer: { ensure, close: vi.fn() },
			});
			const bridge = pairedBridge();

			const forged = seal(
				deriveKeys(newBridgeSecret()),
				'request',
				{ bridgeId: bridge.id, route: 'connect' },
				{},
				time,
			);
			expect((await post(app, 'connect', JSON.stringify(forged))).status).toBe(401);
			expect(ensure).not.toHaveBeenCalled();

			await connect(app, bridge);
			expect(ensure).toHaveBeenCalledOnce();
			expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({ id: bridge.id, chat_channel_id: 'chat' }));

			// A poll of an unknown session (410) still proves the helper is there.
			await call(app, bridge, 'poll', { session: 'not-a-session' });
			expect(ensure).toHaveBeenCalledTimes(2);
		});

		it('never asks it for a replayed or stale request', async () => {
			const ensure = vi.fn(() => Promise.resolve());
			const app = createApp({ auth: null, now, helpers: new HelperHub(now), announcer: { ensure, close: vi.fn() } });
			const bridge = pairedBridge();
			const { request } = await call(app, bridge, 'connect', {});
			ensure.mockClear();

			expect((await post(app, 'connect', JSON.stringify(request))).status).toBe(400);
			const stale = await call(app, bridge, 'connect', {}, time - MAX_CLOCK_SKEW_MS - 1);
			expect(stale.message).toEqual({ error: 'clock' });

			expect(ensure).not.toHaveBeenCalled();
		});
	});
});
