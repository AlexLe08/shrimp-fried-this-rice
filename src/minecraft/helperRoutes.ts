import type { Context, Env, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { MINUTE_MS, createRateLimiter } from '../dashboard/rateLimit.ts';
import type { Announcer } from './announcement.ts';
import { ReplayGuard, open, parseEnvelope, seal } from './bridge/seal.ts';
import type { HelperHub, PollResult } from './helperHub.ts';
import { getBridge, type BridgeKeys } from './storage.ts';

// The helper's endpoint (decision 0009; the plan's A8, "The helper's
// connection to the bot"), served beside the dashboard. The helper isn't a
// browser and has no login: each body is sealed with the bridge's keys
// (bridge/seal.ts), which is its only credential. What can't be sealed, as
// the bot can't yet tell who's asking, is answered in the clear: a malformed
// or oversized body, a rate limit, an unknown bridge or a forged seal.
// Everything else is sealed, so nobody on the way (Cloudflare's edge decrypts
// HTTPS, decision 0008) can tell a helper it was taken over, which would stop
// it until it's restarted.

/** The routes, each `POST /minecraft/<route>`, for ROUTE_ACCESS. */
export const HELPER_ROUTES = ['connect', 'poll'] as const;
type HelperRoute = (typeof HELPER_ROUTES)[number];

// A poll is a few hundred bytes sealed; this leaves room for the helper's
// reports to come (A8e) and bounds what's read before the seal is checked,
// as the rate limits count requests, not bytes.
export const MAX_REQUEST_BYTES = 16 * 1024;
// A held poll is answered as soon as a message comes, so a busy channel means
// a poll per message or so: two a second is far more than a few servers' chat.
export const BRIDGE_REQUESTS_PER_MINUTE = 120;
// Per address, before anything is parsed, so one address can't make the bot
// read and look up bodies without end. Room for a few bridges on one host.
export const HELPER_VISITOR_REQUESTS_PER_MINUTE = 240;

export interface HelperRouteOptions {
	hub: HelperHub;
	now: () => number;
	/** The rate-limit key of the request's address (dashboard/rateLimit.ts's visitorKey). */
	visitorOf: (c: Context) => string;
	/** Announces the relay once its helper is active (decision 0006); none in tests that don't need it. */
	announcer?: Announcer;
}

type Reply = { status: ContentfulStatusCode; message: unknown };
type Handler = (bridgeId: string, message: unknown, signal: AbortSignal) => Reply | Promise<Reply>;

export function registerHelperRoutes<E extends Env>(app: Hono<E>, options: HelperRouteOptions): void {
	const { hub, now, visitorOf, announcer } = options;
	// Made with the routes, so nothing sealed before the bot started opens.
	const replays = new ReplayGuard(now());
	const visitorRequests = createRateLimiter(HELPER_VISITOR_REQUESTS_PER_MINUTE, MINUTE_MS, now);
	const bridgeRequests = createRateLimiter(BRIDGE_REQUESTS_PER_MINUTE, MINUTE_MS, now);

	const handlers: Record<HelperRoute, Handler> = {
		connect: (bridgeId, message) => {
			if (!isObject(message)) return { status: 400, message: { error: 'bad-request' } };
			return { status: 200, message: { session: hub.connect(bridgeId) } };
		},
		poll: async (bridgeId, message, signal) => {
			if (!isObject(message) || typeof message['session'] !== 'string') {
				return { status: 400, message: { error: 'bad-request' } };
			}
			return pollReply(await hub.poll(bridgeId, message['session'], signal));
		},
	};

	const plain = (c: Context, status: ContentfulStatusCode, error: string) => c.json({ error }, status);

	for (const route of HELPER_ROUTES) {
		app.post(
			`/minecraft/${route}`,
			async (c, next) => {
				const wait = visitorRequests.take(visitorOf(c));
				if (wait > 0) return tooMany(c, wait);
				return next();
			},
			bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: (c) => plain(c, 413, 'too-large') }),
			async (c) => {
				if (!isJson(c.req.header('content-type'))) return plain(c, 415, 'json-only');
				let body: unknown;
				try {
					body = await c.req.json();
				} catch {
					return plain(c, 400, 'malformed');
				}
				const envelope = parseEnvelope(body);
				if (!envelope) return plain(c, 400, 'malformed');

				// Before the lookup and the decryption: the bridge's id is in the clear.
				const wait = bridgeRequests.take(envelope.bridge);
				if (wait > 0) return tooMany(c, wait);

				// One answer for both, so a forged request learns nothing about the bridge.
				const bridge = getBridge(envelope.bridge);
				if (!bridge) return plain(c, 401, 'unauthorized');
				const keys: BridgeKeys = { request: bridge.request_key, response: bridge.response_key };
				const context = { bridgeId: bridge.id, route };
				const opened = open(keys, 'request', context, envelope);
				if (!opened.ok) return opened.reason === 'forged' ? plain(c, 401, 'unauthorized') : plain(c, 400, 'malformed');

				const reply = ({ status, message }: Reply) =>
					c.json(seal(keys, 'response', { ...context, replyTo: envelope.iv }, message, now()), status);

				const check = replays.check(opened.nonce, opened.sentAt, now());
				// The real helper never sends one IV twice, so this is someone else's copy.
				if (check === 'replayed') return plain(c, 400, 'replayed');
				// Sealed, with the bot's time inside, so the helper can correct for its clock.
				if (check === 'stale') return reply({ status: 400, message: { error: 'clock' } });

				// Not awaited: the helper's answer doesn't wait on Discord. It's tried
				// on every request, as a refused post is tried again later.
				if (announcer) void announcer.ensure(bridge);
				return reply(await handlers[route](bridge.id, opened.message, c.req.raw.signal));
			},
		);
	}
}

function pollReply(result: PollResult): Reply {
	switch (result.kind) {
		case 'messages':
			return { status: 200, message: { messages: result.messages } };
		case 'taken-over':
			return { status: 409, message: { error: 'taken-over' } };
		case 'session-ended':
			return { status: 410, message: { error: 'session-ended' } };
	}
}

function tooMany(c: Context, waitMs: number) {
	c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
	return c.json({ error: 'rate-limited' }, 429);
}

function isJson(contentType: string | undefined): boolean {
	return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
