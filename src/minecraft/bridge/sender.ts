import { escapeMarkdown, MAX_CONTENT, truncate, type Message } from './messages.ts';

export interface Post extends Message {
	/** The webhook URL. Chat and alerts may share one. */
	webhook: string;
	/**
	 * Chat and join lines can be dropped when the queue overflows; alerts and
	 * start/stop never are.
	 */
	droppable: boolean;
}

export interface SenderOptions {
	/**
	 * The name a post is resent under when Discord refuses a player's name.
	 * Discord's docs give the `clyde`/`discord` rule only for a webhook's own
	 * name, but it refuses `clyde` in a message's username too (the owner's
	 * end-to-end test, 2026-11-21).
	 */
	fallbackUsername: string;
	fetch?: typeof fetch;
	log?: (message: string) => void;
	/** Posts queued within this long of the first are batched. Defaults to 1 s. */
	batchMs?: number;
	/** Past this many queued posts per webhook, the oldest droppable ones go. Defaults to 200. */
	maxQueued?: number;
	/** Tries for a post that fails with a network error, a timeout or a 5xx. Defaults to 5. */
	maxAttempts?: number;
	/** 429s in a row before a post is dropped. Defaults to 10. */
	maxRateLimited?: number;
	/** How long one request may take. Defaults to 15 s. */
	requestTimeoutMs?: number;
}

export interface Sender {
	send(post: Post): void;
	/**
	 * Sends what's queued without waiting to batch or retrying, for up to
	 * `timeoutMs`; then aborts what's under way, drops the rest, and ignores
	 * later sends.
	 */
	close(timeoutMs: number): Promise<void>;
}

interface Queue {
	items: Post[];
	running: Promise<void> | null;
	/** Posts in the batch being delivered, so close can count them as unsent. */
	inFlight: number;
	/** Discord answered 401 or 404, or the URL is malformed: no more posts go to it. */
	dead: boolean;
	/** When the next post may go, from the rate limit headers. */
	notBefore: number;
}

// Discord's 429 says how long to wait; a zero or negative value (a proxy's,
// say) must not turn the retry into a tight loop.
const MIN_RETRY_AFTER_MS = 100;

export function createSender(options: SenderOptions): Sender {
	const doFetch = options.fetch ?? fetch;
	const log = options.log ?? ((message: string) => console.error(`[mcbridge] ${message}`));
	const batchMs = options.batchMs ?? 1000;
	const maxQueued = options.maxQueued ?? 200;
	const maxAttempts = options.maxAttempts ?? 5;
	const maxRateLimited = options.maxRateLimited ?? 10;
	const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
	const queues = new Map<string, Queue>();
	// Names Discord refused once: later posts from them go straight to the fallback.
	const refusedNames = new Set<string>();
	/** Draining: no batch wait, no retries. */
	let closing = false;
	/** Aborted when close starts: ends the batch wait. */
	const draining = new AbortController();
	/** Aborted past close's deadline: everything stops. */
	const stopper = new AbortController();

	/** Waits `ms`, or less if `signal` aborts first. */
	function pause(ms: number, signal: AbortSignal = stopper.signal): Promise<void> {
		if (signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener('abort', done);
		});
	}

	function queueFor(webhook: string): Queue {
		let queue = queues.get(webhook);
		if (!queue) {
			queue = { items: [], running: null, inFlight: 0, dead: false, notBefore: 0 };
			queues.set(webhook, queue);
		}
		return queue;
	}

	function trim(queue: Queue): void {
		let dropped = 0;
		while (queue.items.length > maxQueued) {
			const index = queue.items.findIndex((item) => item.droppable);
			if (index === -1) break;
			queue.items.splice(index, 1);
			dropped++;
		}
		if (dropped) log(`queue full: dropped ${dropped} chat or join ${dropped === 1 ? 'line' : 'lines'}`);
	}

	/** The head post, joined with the ones after it from the same sender while they fit. */
	function takeBatch(queue: Queue): { post: Post; count: number } {
		const head = queue.items.shift()!;
		let { content, droppable } = head;
		let count = 1;
		while (queue.items.length) {
			const next = queue.items[0]!;
			if (next.username !== head.username || next.avatarUrl !== head.avatarUrl) break;
			const joined = `${content}\n${next.content}`;
			if (joined.length > MAX_CONTENT) break;
			content = joined;
			droppable &&= next.droppable;
			queue.items.shift();
			count++;
		}
		return { post: { ...head, content, droppable }, count };
	}

	function kick(webhook: string, queue: Queue): void {
		queue.running ??= run(webhook, queue)
			.catch((error: unknown) => {
				// Nothing in the sender may crash the helper; a bug here loses posts, not the process.
				log(`unexpected error, dropped this webhook's queued posts: ${String(error)}`);
				queue.items = [];
			})
			.finally(() => {
				queue.running = null;
				queue.inFlight = 0;
				// A post can arrive between the last delivery and this.
				if (queue.items.length && !queue.dead && !stopper.signal.aborted) kick(webhook, queue);
			});
	}

	async function run(webhook: string, queue: Queue): Promise<void> {
		await pause(batchMs, draining.signal);
		while (queue.items.length && !queue.dead && !stopper.signal.aborted) {
			const { post, count } = takeBatch(queue);
			queue.inFlight = count;
			await deliver(webhook, queue, post);
			queue.inFlight = 0;
		}
	}

	/** The post as the fallback sender, each line naming who said it. */
	function asFallback(post: Post): Post {
		if (post.username === options.fallbackUsername) return post;
		const name = escapeMarkdown(post.username);
		const content = post.content
			.split('\n')
			.map((line) => `**${name}:** ${line}`)
			.join('\n');
		// The picture was the player's; under the server's name it would mislead.
		const fallback: Post = { ...post, username: options.fallbackUsername, content };
		delete fallback.avatarUrl;
		return fallback;
	}

	async function deliver(webhook: string, queue: Queue, original: Post): Promise<void> {
		let url: string;
		try {
			url = urlFor(webhook);
		} catch {
			queue.dead = true;
			queue.items = [];
			log(`webhook ${redact(webhook)} isn't a valid URL; no posts go to it`);
			return;
		}
		let post = refusedNames.has(original.username) ? asFallback(original) : original;
		let attempts = 0;
		let rateLimited = 0;

		for (;;) {
			const wait = queue.notBefore - Date.now();
			if (wait > 0) await pause(wait);
			if (stopper.signal.aborted) return;

			const request = new AbortController();
			const onStop = () => request.abort();
			stopper.signal.addEventListener('abort', onStop);
			const timer = setTimeout(() => request.abort(), requestTimeoutMs);
			let response: Response;
			try {
				response = await doFetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					// Minecraft chat can contain @everyone or a role mention; nothing it
					// says may ping anyone.
					body: JSON.stringify({
						content: truncate(post.content),
						username: post.username,
						...(post.avatarUrl === undefined ? {} : { avatar_url: post.avatarUrl }),
						allowed_mentions: { parse: [] },
					}),
					signal: request.signal,
				});
			} catch (error) {
				if (await retryLater(request.signal.aborted ? 'request timed out' : `network error: ${String(error)}`)) {
					continue;
				}
				return;
			} finally {
				clearTimeout(timer);
				stopper.signal.removeEventListener('abort', onStop);
			}

			noteRateLimit(queue, response);
			if (response.ok) {
				// With wait=true the body is the message; unread, it holds the connection.
				await discard(response);
				return;
			}

			if (response.status === 429) {
				const seconds = await retryAfter(response);
				rateLimited++;
				if (closing || rateLimited >= maxRateLimited) {
					log(`rate limited ${rateLimited} ${rateLimited === 1 ? 'time' : 'times'}; dropped a post`);
					return;
				}
				queue.notBefore = Math.max(queue.notBefore, Date.now() + Math.max(seconds * 1000, MIN_RETRY_AFTER_MS));
				continue;
			}
			if (response.status === 400 && post.username !== options.fallbackUsername) {
				await discard(response);
				log(`Discord refused a post as ${JSON.stringify(post.username)}; sending it as ${options.fallbackUsername}`);
				refusedNames.add(post.username);
				post = asFallback(post);
				continue;
			}
			if (response.status === 401 || response.status === 404) {
				await discard(response);
				// Discord: a webhook that returns 404 should not be used again.
				queue.dead = true;
				queue.items = [];
				log(
					`webhook ${redact(webhook)} answered ${response.status}: it was deleted or its URL is wrong. No more posts go to it until mcbridge restarts.`,
				);
				return;
			}
			if (response.status >= 500) {
				await discard(response);
				if (await retryLater(`Discord answered ${response.status}`)) continue;
				return;
			}
			log(`Discord refused a post (${response.status}): ${await bodyText(response)}`);
			return;
		}

		async function retryLater(reason: string): Promise<boolean> {
			attempts++;
			if (attempts >= maxAttempts || closing) {
				log(`${reason}; dropped a post after ${attempts} ${attempts === 1 ? 'try' : 'tries'}`);
				return false;
			}
			await pause(Math.min(1000 * 2 ** (attempts - 1), 30_000));
			return !stopper.signal.aborted;
		}
	}

	async function drain(): Promise<void> {
		// A post sent while draining starts a new run, so look again until none is left.
		for (;;) {
			const running = [...queues.values()].map((queue) => queue.running).filter((run) => run !== null);
			if (running.length === 0) return;
			await Promise.all(running);
		}
	}

	return {
		send(post) {
			if (stopper.signal.aborted || post.content.trim() === '') return;
			const queue = queueFor(post.webhook);
			if (queue.dead) return;
			queue.items.push(post);
			trim(queue);
			kick(post.webhook, queue);
		},
		async close(timeoutMs) {
			closing = true;
			draining.abort();
			let timer: NodeJS.Timeout | undefined;
			const timedOut = new Promise<'timeout'>((resolve) => {
				timer = setTimeout(() => resolve('timeout'), timeoutMs);
			});
			const result = await Promise.race([drain(), timedOut]);
			clearTimeout(timer);
			if (result !== 'timeout') return;
			const left = [...queues.values()].reduce((sum, queue) => sum + queue.items.length + queue.inFlight, 0);
			for (const queue of queues.values()) queue.items = [];
			stopper.abort();
			log(`stopped with ${left} ${left === 1 ? 'post' : 'posts'} unsent`);
		},
	};
}

function urlFor(webhook: string): string {
	const url = new URL(webhook);
	// Without wait, Discord answers 204 even for a message it didn't save.
	url.searchParams.set('wait', 'true');
	return url.toString();
}

function noteRateLimit(queue: Queue, response: Response): void {
	if (response.headers.get('X-RateLimit-Remaining') !== '0') return;
	const resetAfter = Number(response.headers.get('X-RateLimit-Reset-After'));
	if (Number.isFinite(resetAfter)) queue.notBefore = Math.max(queue.notBefore, Date.now() + resetAfter * 1000);
}

async function retryAfter(response: Response): Promise<number> {
	try {
		const body = (await response.json()) as { retry_after?: unknown };
		if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) return body.retry_after;
	} catch {
		// Not JSON (a proxy's 429, say): fall back to the header.
	}
	const header = Number(response.headers.get('Retry-After'));
	return Number.isFinite(header) && header > 0 ? header : 1;
}

async function bodyText(response: Response): Promise<string> {
	try {
		return (await response.text()).slice(0, 300);
	} catch {
		return '(no body)';
	}
}

async function discard(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Already read or closed: nothing held.
	}
}

// The token in a webhook URL is the whole secret: never print it.
function redact(webhook: string): string {
	return webhook.replace(/\/webhooks\/(\d+)\/[^/?]+/, '/webhooks/$1/…');
}
