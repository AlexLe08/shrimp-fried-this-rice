import type { BotConfig } from './config.ts';
import { deriveKeys, open, parseEnvelope, seal } from './seal.ts';

// The helper's side of two-way chat (decision 0006; the plan's A8, "The
// helper's connection to the bot"): the Minecraft host can't be reached from
// outside, so the helper connects out and long-polls the bot's endpoint
// (src/minecraft/helperRoutes.ts) for chat to run in game. Every body is
// sealed with the bridge's keys (seal.ts), the only credential. Node's own
// fetch only, so the helper stays dependency-free.

/** Longer than the bot holds a poll (50 s), so a held poll ends on the bot's side first. */
export const REQUEST_TIMEOUT_MS = 70_000;
export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;
/** The least time between polls answered with nothing, as a bot shutting down answers each at once. */
export const MIN_EMPTY_POLL_GAP_MS = 1000;

/** Chat from Discord, for the game. */
export interface BotChat {
	kind: 'chat';
	name: string;
	text: string;
}

/** Why the helper stopped talking to the bot until it's restarted: each needs a person. */
export type StopReason =
	/** Another helper connected with this bridge's secret, and the older one stops. */
	| 'taken-over'
	/** The secret was regenerated or the bridge removed in the dashboard. */
	| 'unauthorized';

export interface BotClientOptions {
	bot: BotConfig;
	onChat: (chat: BotChat[]) => void;
	onStopped: (reason: StopReason) => void;
	fetch?: typeof fetch;
	now?: () => number;
	log?: (message: string) => void;
	requestTimeoutMs?: number;
}

export interface BotClient {
	start(): void;
	/** Ends a poll under way and any wait, and resolves once the loop has ended. */
	stop(): Promise<void>;
}

type Answer =
	| { kind: 'ok'; message: unknown }
	| { kind: 'session-ended' }
	| { kind: 'clock'; botTime: number }
	| { kind: 'taken-over' }
	| { kind: 'unauthorized' }
	| { kind: 'rate-limited'; waitMs: number }
	| { kind: 'failed'; why: string };

export function createBotClient(options: BotClientOptions): BotClient {
	const { bot } = options;
	const keys = deriveKeys(bot.secret);
	const fetchFn = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const log = options.log ?? ((message: string) => console.error(`[mcbridge] ${message}`));
	const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	// Routes resolve against it, which keeps its last segment only with a slash:
	// `…/minecraft` would send them to `…/connect`.
	const base = bot.url.endsWith('/') ? bot.url : `${bot.url}/`;

	let stopped = false;
	let running: Promise<void> | null = null;
	let inFlight: AbortController | null = null;
	let endWait: (() => void) | null = null;
	// The bot's clock minus ours, learnt when it refuses our time: it accepts
	// a sealed time within 5 minutes of its own.
	let clockOffset = 0;

	function wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				endWait = null;
				resolve();
			}
			endWait = done;
		});
	}

	async function request(route: 'connect' | 'poll', message: unknown): Promise<Answer> {
		// Sealed again for each try, so each has a new IV: the bot refuses one it has seen.
		const sent = seal(keys, 'request', { bridgeId: bot.bridge, route }, message, now() + clockOffset);
		const controller = new AbortController();
		inFlight = controller;
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response: Response;
		let body: unknown;
		try {
			response = await fetchFn(new URL(route, base), {
				method: 'POST',
				// Required: the endpoint takes JSON only, which also keeps it clear of the dashboard's CSRF check.
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(sent),
				signal: controller.signal,
			});
			// Each read or cancelled, so its connection is let go.
			if (response.status === 429) {
				await response.body?.cancel();
				return { kind: 'rate-limited', waitMs: retryAfterMs(response) };
			}
			if (response.status === 401) {
				await response.body?.cancel();
				return { kind: 'unauthorized' };
			}
			body = await response.json().catch(() => undefined);
		} catch (error) {
			return { kind: 'failed', why: controller.signal.aborted ? 'no answer in time' : describe(error) };
		} finally {
			clearTimeout(timer);
			inFlight = null;
		}

		// Anything not sealed for this request is someone else's: Cloudflare's
		// error pages, or a reply meant for another request.
		const envelope = parseEnvelope(body);
		if (!envelope) return { kind: 'failed', why: `HTTP ${response.status}` };
		const opened = open(keys, 'response', { bridgeId: bot.bridge, route, replyTo: sent.iv }, envelope);
		if (!opened.ok) return { kind: 'failed', why: `an answer that didn't open (HTTP ${response.status})` };

		const error = isObject(opened.message) ? opened.message['error'] : undefined;
		if (response.status === 200) return { kind: 'ok', message: opened.message };
		if (response.status === 409) return { kind: 'taken-over' };
		if (response.status === 410) return { kind: 'session-ended' };
		if (response.status === 400 && error === 'clock') return { kind: 'clock', botTime: opened.sentAt };
		return { kind: 'failed', why: `HTTP ${response.status}${typeof error === 'string' ? ` ${error}` : ''}` };
	}

	async function run(): Promise<void> {
		let session: string | null = null;
		let backoffMs = 0;
		let clockFixes = 0;
		while (!stopped) {
			const askedAt = now();
			const answer = await request(session ? 'poll' : 'connect', session ? { session } : {});
			if (stopped) return;
			switch (answer.kind) {
				case 'ok': {
					clockFixes = 0;
					if (session === null) {
						const given = isObject(answer.message) ? answer.message['session'] : undefined;
						if (typeof given !== 'string') {
							// A bot of another version, or a broken one: not a reason to ask again at once.
							backoffMs = nextBackoff(backoffMs);
							log(`the bot's answer had no session; trying again in ${backoffMs / 1000} s`);
							await wait(backoffMs);
							break;
						}
						backoffMs = 0;
						session = given;
						log('connected to the bot');
						break;
					}
					backoffMs = 0;
					const chat = chatIn(answer.message);
					if (chat.length > 0) {
						call(() => options.onChat(chat), 'handling chat from the bot');
					} else if (now() - askedAt < MIN_EMPTY_POLL_GAP_MS) {
						// A poll is held until there's something, so nothing at once means the bot is closing.
						await wait(MIN_EMPTY_POLL_GAP_MS - (now() - askedAt));
					}
					break;
				}
				case 'session-ended':
					// The lease lapsed, or the bot restarted: connect again at once.
					session = null;
					break;
				case 'clock':
					clockOffset = answer.botTime - now();
					log(`this computer's clock is ${Math.round(clockOffset / 1000)} s off the bot's; correcting for it`);
					// Once is enough unless the clock is jumping: then back off rather than loop.
					if (++clockFixes > 1) {
						backoffMs = nextBackoff(backoffMs);
						await wait(backoffMs);
					}
					break;
				case 'taken-over':
				case 'unauthorized':
					stopped = true;
					call(() => options.onStopped(answer.kind), 'reporting why it stopped');
					return;
				case 'rate-limited':
					log(`the bot asked to slow down; waiting ${Math.round(answer.waitMs / 1000)} s`);
					await wait(answer.waitMs);
					break;
				case 'failed':
					backoffMs = nextBackoff(backoffMs);
					log(`the bot couldn't be reached (${answer.why}); trying again in ${backoffMs / 1000} s`);
					await wait(backoffMs);
					break;
			}
		}
	}

	// The loop outlives anything a callback gets wrong: an unhandled rejection
	// would end the helper, one-way relay and all.
	function call(callback: () => void, doing: string): void {
		try {
			callback();
		} catch (error) {
			log(`${doing} failed: ${describe(error)}`);
		}
	}

	return {
		start() {
			if (running || stopped) return;
			running = run().catch((error: unknown) => log(`the connection to the bot stopped: ${describe(error)}`));
		},
		async stop() {
			stopped = true;
			inFlight?.abort();
			endWait?.();
			await running;
		},
	};
}

function nextBackoff(previous: number): number {
	return previous === 0 ? MIN_BACKOFF_MS : Math.min(previous * 2, MAX_BACKOFF_MS);
}

// The bot sends whole seconds; without the header, wait as after a failure.
function retryAfterMs(response: Response): number {
	const seconds = Number(response.headers.get('Retry-After'));
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_BACKOFF_MS) : MAX_BACKOFF_MS;
}

// Kinds the helper doesn't know (a newer bot) are skipped, not fatal.
function chatIn(message: unknown): BotChat[] {
	const messages = isObject(message) ? message['messages'] : undefined;
	if (!Array.isArray(messages)) return [];
	return messages.filter(
		(m): m is BotChat =>
			isObject(m) && m['kind'] === 'chat' && typeof m['name'] === 'string' && typeof m['text'] === 'string',
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The error's own words: Node's fetch errors name the cause, not the body sent.
function describe(error: unknown): string {
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
	const message = (error as { message?: unknown } | null)?.message;
	return [typeof message === 'string' ? message : 'error', typeof cause === 'string' ? cause : '']
		.filter(Boolean)
		.join(': ');
}
