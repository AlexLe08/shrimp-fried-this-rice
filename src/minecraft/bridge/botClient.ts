import type { LinkReport } from './bridge.ts';
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
/** A report isn't held like a poll, so an answer this late means something's wrong on the way. */
export const REPORT_TIMEOUT_MS = 15_000;
/** How long a player waits for the bot's answer to their `!link` line before the helper answers for it. */
export const REPORT_DEADLINE_MS = 60_000;

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
	/** The bridge's settings as the bot sent them, unchecked (settings.ts checks them): with each connect, and when they change. */
	onSettings?: (settings: unknown) => void;
	fetch?: typeof fetch;
	now?: () => number;
	log?: (message: string) => void;
	requestTimeoutMs?: number;
}

/** The bot's answer to a `!link` report: the text to show that player alone. */
export interface LinkAnswer {
	result: string;
	text: string;
}

export interface BotClient {
	start(): void;
	/**
	 * Sends the bot a player's `!link` line and resolves with its answer, or
	 * null when there's none to show: the bot couldn't be reached in time,
	 * refused the report, or the helper is stopping.
	 */
	report(link: LinkReport): Promise<LinkAnswer | null>;
	/** Ends a poll or report under way and any wait, and resolves once the loop has ended. */
	stop(): Promise<void>;
}

type Answer =
	| { kind: 'ok'; message: unknown }
	| { kind: 'session-ended' }
	| { kind: 'clock'; botTime: number }
	| { kind: 'taken-over' }
	| { kind: 'unauthorized' }
	| { kind: 'rate-limited'; waitMs: number }
	/** `byBot` when the bot itself answered no (sealed), so the same request would only be refused again. */
	| { kind: 'failed'; why: string; byBot?: true };

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
	// The poll loop's and any `!link` reports': stop ends them all.
	const inFlight = new Set<AbortController>();
	const waits = new Set<() => void>();
	// The bot's clock minus ours, learnt when it refuses our time: it accepts
	// a sealed time within 5 minutes of its own.
	let clockOffset = 0;

	function wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				waits.delete(done);
				resolve();
			}
			waits.add(done);
		});
	}

	async function request(route: 'connect' | 'poll' | 'link', message: unknown, limitMs = timeoutMs): Promise<Answer> {
		// Sealed again for each try, so each has a new IV: the bot refuses one it has seen.
		const sent = seal(keys, 'request', { bridgeId: bot.bridge, route }, message, now() + clockOffset);
		const controller = new AbortController();
		inFlight.add(controller);
		const timer = setTimeout(() => controller.abort(), limitMs);
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
			inFlight.delete(controller);
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
		return {
			kind: 'failed',
			why: `HTTP ${response.status}${typeof error === 'string' ? ` ${error}` : ''}`,
			byBot: true,
		};
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
						const settings = isObject(answer.message) ? answer.message['settings'] : undefined;
						if (settings !== undefined) giveSettings(settings);
						break;
					}
					backoffMs = 0;
					const latest = settingsIn(answer.message);
					if (latest !== undefined) giveSettings(latest);
					const chat = chatIn(answer.message);
					if (chat.length > 0) {
						call(() => options.onChat(chat), 'handling chat from the bot');
					} else if (latest === undefined && now() - askedAt < MIN_EMPTY_POLL_GAP_MS) {
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

	function giveSettings(settings: unknown): void {
		const onSettings = options.onSettings;
		if (onSettings) call(() => onSettings(settings), 'applying the bridge settings');
	}

	// Beside the poll loop, not through it: a report mustn't wait for a held
	// poll. The player is waiting in game, so it's given up on after
	// REPORT_DEADLINE_MS, well inside the code's 10 minutes.
	async function report(link: LinkReport): Promise<LinkAnswer | null> {
		const deadline = now() + REPORT_DEADLINE_MS;
		let backoffMs = 0;
		let clockFixed = false;
		while (!stopped) {
			const answer = await request('link', link, REPORT_TIMEOUT_MS);
			if (stopped) return null;
			let waitMs: number;
			switch (answer.kind) {
				case 'ok': {
					const message = answer.message;
					if (isObject(message) && typeof message['result'] === 'string' && typeof message['text'] === 'string') {
						return { result: message['result'], text: message['text'] };
					}
					log(`the bot's answer to ${link.player}'s !link had no text`);
					return null;
				}
				case 'clock':
					clockOffset = answer.botTime - now();
					// Once is enough unless the clock is jumping.
					if (clockFixed) return gaveUp(link, 'its clock keeps moving');
					clockFixed = true;
					continue;
				case 'rate-limited':
					// Polls and reports share the bridge's limit (the plan's A8): wait it out.
					waitMs = answer.waitMs;
					break;
				case 'failed':
					if (answer.byBot) return gaveUp(link, answer.why);
					backoffMs = nextBackoff(backoffMs);
					waitMs = backoffMs;
					break;
				default:
					// 401, or a 409 or 410 that no link answer should get.
					return gaveUp(link, answer.kind);
			}
			if (now() + waitMs > deadline) return gaveUp(link, 'no answer in time');
			await wait(waitMs);
		}
		return null;
	}

	function gaveUp(link: LinkReport, why: string): null {
		log(`couldn't check ${link.player}'s !link with the bot (${why})`);
		return null;
	}

	return {
		start() {
			if (running || stopped) return;
			running = run().catch((error: unknown) => log(`the connection to the bot stopped: ${describe(error)}`));
		},
		report,
		async stop() {
			stopped = true;
			for (const controller of inFlight) controller.abort();
			for (const done of waits) done();
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

// The last settings message in an answer: each is complete, so only the latest matters.
function settingsIn(message: unknown): unknown {
	const messages = isObject(message) ? message['messages'] : undefined;
	if (!Array.isArray(messages)) return undefined;
	return messages.findLast((m) => isObject(m) && m['kind'] === 'settings');
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
