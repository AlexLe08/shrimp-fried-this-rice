import { MAX_CONTENT, truncate, type Message } from './messages.ts';

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
	 * name; whether it also applies to a message's username is unverified.
	 */
	fallbackUsername: string;
	fetch?: typeof fetch;
	log?: (message: string) => void;
	/** Posts queued within this long of the first are batched. Defaults to 1 s. */
	batchMs?: number;
	/** Past this many queued posts per webhook, the oldest droppable ones go. Defaults to 200. */
	maxQueued?: number;
	/** Tries for a post that fails with a network error or a 5xx. Defaults to 5. */
	maxAttempts?: number;
}

export interface Sender {
	send(post: Post): void;
	/** Sends what's queued without waiting to batch, for up to `timeoutMs`; drops the rest. */
	close(timeoutMs: number): Promise<void>;
}

interface Queue {
	items: Post[];
	running: Promise<void> | null;
	/** Discord answered 401 or 404: the webhook was deleted or its URL is wrong. */
	dead: boolean;
	/** When the next post may go, from the rate limit headers. */
	notBefore: number;
	/** Ends the batch wait early, for close. */
	wake: (() => void) | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSender(options: SenderOptions): Sender {
	const doFetch = options.fetch ?? fetch;
	const log = options.log ?? ((message: string) => console.error(`[mcbridge] ${message}`));
	const batchMs = options.batchMs ?? 1000;
	const maxQueued = options.maxQueued ?? 200;
	const maxAttempts = options.maxAttempts ?? 5;
	const queues = new Map<string, Queue>();
	let closing = false;

	function queueFor(webhook: string): Queue {
		let queue = queues.get(webhook);
		if (!queue) {
			queue = { items: [], running: null, dead: false, notBefore: 0, wake: null };
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
		if (dropped) log(`queue full: dropped ${dropped} chat ${dropped === 1 ? 'line' : 'lines'}`);
	}

	/** The head post, joined with the ones after it from the same sender while they fit. */
	function takeBatch(queue: Queue): Post {
		const head = queue.items.shift()!;
		let { content, droppable } = head;
		while (queue.items.length) {
			const next = queue.items[0]!;
			if (next.username !== head.username) break;
			const joined = `${content}\n${next.content}`;
			if (joined.length > MAX_CONTENT) break;
			content = joined;
			droppable &&= next.droppable;
			queue.items.shift();
		}
		return { ...head, content, droppable };
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
				// A post can arrive between the last delivery and this.
				if (queue.items.length && !queue.dead) kick(webhook, queue);
			});
	}

	async function run(webhook: string, queue: Queue): Promise<void> {
		if (!closing) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, batchMs);
				queue.wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			queue.wake = null;
		}
		while (queue.items.length && !queue.dead) {
			await deliver(webhook, queue, takeBatch(queue));
		}
	}

	async function deliver(webhook: string, queue: Queue, post: Post): Promise<void> {
		// Outside the retry loop: a malformed URL is a config mistake, not a network error.
		const url = urlFor(webhook);
		let username = post.username;
		let attempts = 0;
		for (;;) {
			const wait = queue.notBefore - Date.now();
			if (wait > 0) await sleep(wait);

			let response: Response;
			try {
				response = await doFetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					// Minecraft chat can contain @everyone or a role mention; nothing it
					// says may ping anyone.
					body: JSON.stringify({ content: truncate(post.content), username, allowed_mentions: { parse: [] } }),
				});
			} catch (error) {
				if (await retryLater(`network error: ${String(error)}`)) continue;
				return;
			}

			noteRateLimit(queue, response);
			if (response.ok) return;

			if (response.status === 429) {
				const seconds = await retryAfter(response);
				queue.notBefore = Math.max(queue.notBefore, Date.now() + seconds * 1000);
				continue;
			}
			if (response.status === 400 && username !== options.fallbackUsername) {
				log(`Discord refused a post as ${JSON.stringify(username)}; sending it as ${options.fallbackUsername}`);
				username = options.fallbackUsername;
				continue;
			}
			if (response.status === 401 || response.status === 404) {
				// Discord: a webhook that returns 404 should not be used again.
				queue.dead = true;
				queue.items = [];
				log(
					`webhook ${redact(webhook)} answered ${response.status}: it was deleted or its URL is wrong. No more posts go to it until mcbridge restarts.`,
				);
				return;
			}
			if (response.status >= 500 && (await retryLater(`Discord answered ${response.status}`))) continue;
			if (response.status < 500) log(`Discord refused a post (${response.status}): ${await bodyText(response)}`);
			return;
		}

		async function retryLater(reason: string): Promise<boolean> {
			attempts++;
			if (attempts >= maxAttempts || closing) {
				log(`${reason}; dropped a post after ${attempts} ${attempts === 1 ? 'try' : 'tries'}`);
				return false;
			}
			await sleep(Math.min(1000 * 2 ** (attempts - 1), 30_000));
			return true;
		}
	}

	return {
		send(post) {
			if (post.content.trim() === '') return;
			const queue = queueFor(post.webhook);
			if (queue.dead) return;
			queue.items.push(post);
			trim(queue);
			kick(post.webhook, queue);
		},
		async close(timeoutMs) {
			closing = true;
			for (const queue of queues.values()) queue.wake?.();
			const drained = Promise.all([...queues.values()].map((queue) => queue.running));
			let timer: NodeJS.Timeout | undefined;
			const timedOut = new Promise<'timeout'>((resolve) => {
				timer = setTimeout(() => resolve('timeout'), timeoutMs);
			});
			const result = await Promise.race([drained, timedOut]);
			clearTimeout(timer);
			if (result === 'timeout') {
				const left = [...queues.values()].reduce((sum, queue) => sum + queue.items.length, 0);
				log(`stopped with ${left} ${left === 1 ? 'post' : 'posts'} unsent`);
			}
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
		if (typeof body.retry_after === 'number') return body.retry_after;
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

// The token in a webhook URL is the whole secret: never print it.
function redact(webhook: string): string {
	return webhook.replace(/\/webhooks\/(\d+)\/[^/?]+/, '/webhooks/$1/…');
}
