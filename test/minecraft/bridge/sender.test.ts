import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSender, type Post, type SenderOptions } from '../../../src/minecraft/bridge/sender.ts';

const WEBHOOK = 'https://discord.com/api/webhooks/123/secret-token';
const OTHER = 'https://discord.com/api/webhooks/456/other-token';

const chat = (username: string, content: string): Post => ({ webhook: WEBHOOK, username, content, droppable: true });
const alertPost = (content: string): Post => ({ webhook: WEBHOOK, username: 'Survival', content, droppable: false });

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
const ok = () => json(200, { id: '1' });

function setup(responses: Array<Response | Error> = [], options: Partial<SenderOptions> = {}) {
	const fetch = vi.fn<typeof globalThis.fetch>(async () => {
		const next = responses.shift() ?? ok();
		if (next instanceof Error) throw next;
		return next;
	});
	const log = vi.fn<(message: string) => void>();
	const sender = createSender({
		fallbackUsername: 'Survival',
		fetch,
		log,
		...options,
	});
	const bodies = () =>
		fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string) as { content: string; username: string });
	return { sender, fetch, log, bodies };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createSender', () => {
	it('posts with wait=true and no mentions allowed', async () => {
		const { sender, fetch } = setup();
		sender.send(chat('Steve', '@everyone look'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0]!;
		expect(new URL(String(url)).searchParams.get('wait')).toBe('true');
		expect(init!.method).toBe('POST');
		expect(JSON.parse(init!.body as string)).toEqual({
			content: '@everyone look',
			username: 'Steve',
			allowed_mentions: { parse: [] },
		});
	});

	it('batches lines from one sender within the batch window, keeping order across senders', async () => {
		const { sender, bodies } = setup();
		sender.send(chat('Steve', 'one'));
		sender.send(chat('Steve', 'two'));
		sender.send(chat('Alex', 'three'));
		sender.send(chat('Steve', 'four'));
		await vi.advanceTimersByTimeAsync(999);
		expect(bodies()).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(bodies().map(({ username, content }) => [username, content])).toEqual([
			['Steve', 'one\ntwo'],
			['Alex', 'three'],
			['Steve', 'four'],
		]);
	});

	it('keeps a batch within 2000 characters', async () => {
		const { sender, bodies } = setup();
		sender.send(chat('Steve', 'a'.repeat(1500)));
		sender.send(chat('Steve', 'b'.repeat(600)));
		await vi.advanceTimersByTimeAsync(1000);
		expect(bodies().map(({ content }) => content.length)).toEqual([1500, 600]);
	});

	it('cuts a single post longer than 2000 characters', async () => {
		const { sender, bodies } = setup();
		sender.send(alertPost('x'.repeat(2500)));
		await vi.advanceTimersByTimeAsync(1000);
		expect(bodies()[0]!.content).toHaveLength(2000);
		expect(bodies()[0]!.content.endsWith('…')).toBe(true);
	});

	it('ignores an empty post', async () => {
		const { sender, fetch } = setup();
		sender.send(chat('Steve', '   '));
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('waits retry_after seconds on a 429 and resends the same post', async () => {
		const { sender, fetch, bodies } = setup([json(429, { message: 'rate limited', retry_after: 2.5, global: false })]);
		sender.send(alertPost('boom'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(2499);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(bodies().map(({ content }) => content)).toEqual(['boom', 'boom']);
	});

	it('holds the next post until the bucket resets when none remain', async () => {
		const { sender, fetch } = setup([json(200, {}, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '3' })]);
		sender.send(chat('Steve', 'one'));
		sender.send(chat('Alex', 'two'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(2999);
		expect(fetch).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("resends under the server's name when Discord refuses the player's, naming them on each line", async () => {
		const { sender, bodies, log } = setup([json(400, { code: 50035 })]);
		sender.send(chat('discord_fan', 'hi'));
		sender.send(chat('discord_fan', 'again'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(bodies().map(({ username, content }) => [username, content])).toEqual([
			['discord_fan', 'hi\nagain'],
			['Survival', '**discord\\_fan:** hi\n**discord\\_fan:** again'],
		]);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('"discord_fan"'));
	});

	it("falls back to the server's current name when it's given as a function (renamed in the dashboard)", async () => {
		let name = 'Survival';
		const { sender, bodies } = setup([json(400, { code: 50035 })], { fallbackUsername: () => name });
		name = 'Creative';
		sender.send(chat('discord_fan', 'hi'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(bodies().at(-1)!.username).toBe('Creative');
	});

	it("sends a post's picture, and batches only lines with the same name and picture", async () => {
		const { sender, fetch } = setup();
		const steve = (content: string, avatarUrl?: string): Post => ({
			...chat('Steve', content),
			...(avatarUrl === undefined ? {} : { avatarUrl }),
		});
		sender.send(steve('one', 'https://x.test/a.png'));
		sender.send(steve('two', 'https://x.test/a.png'));
		sender.send(steve('three', 'https://x.test/b.png'));
		sender.send(steve('four'));
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string) as object)).toEqual([
			{ content: 'one\ntwo', username: 'Steve', avatar_url: 'https://x.test/a.png', allowed_mentions: { parse: [] } },
			{ content: 'three', username: 'Steve', avatar_url: 'https://x.test/b.png', allowed_mentions: { parse: [] } },
			{ content: 'four', username: 'Steve', allowed_mentions: { parse: [] } },
		]);
	});

	it("drops the player's picture when resending under the server's name", async () => {
		const { sender, fetch } = setup([json(400, { code: 50035 })]);
		sender.send({ ...chat('discordfan', 'hi'), avatarUrl: 'https://x.test/a.png' });
		await vi.advanceTimersByTimeAsync(1000);
		const sent = fetch.mock.calls.map(
			([, init]) => JSON.parse(init!.body as string) as { username: string; avatar_url?: string },
		);
		expect(sent.map((body) => [body.username, body.avatar_url])).toEqual([
			['discordfan', 'https://x.test/a.png'],
			['Survival', undefined],
		]);
	});

	it('sends a refused name straight to the fallback next time', async () => {
		const { sender, bodies } = setup([json(400, { code: 50035 })]);
		sender.send(chat('discordfan', 'hi'));
		await vi.advanceTimersByTimeAsync(1000);
		sender.send(chat('discordfan', 'later'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(bodies().map(({ username }) => username)).toEqual(['discordfan', 'Survival', 'Survival']);
	});

	it('gives up on a post refused under the fallback name too, without looping', async () => {
		const { sender, fetch, log } = setup([json(400, { code: 50035 }), json(400, { code: 50035 })]);
		sender.send(chat('Steve', 'hi'));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenLastCalledWith(expect.stringContaining('refused a post (400)'));
	});

	it('stops posting to a deleted webhook, keeps its token out of the log, and leaves other webhooks alone', async () => {
		const { sender, fetch, log } = setup([json(404, { code: 10015 })]);
		sender.send(alertPost('first'));
		sender.send({ ...alertPost('elsewhere'), webhook: OTHER });
		await vi.advanceTimersByTimeAsync(1000);
		sender.send(alertPost('second'));
		await vi.advanceTimersByTimeAsync(5000);
		const paths = fetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
		expect(paths).toEqual(['/api/webhooks/123/secret-token', '/api/webhooks/456/other-token']);
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]![0]).toContain('/webhooks/123/…');
		expect(log.mock.calls[0]![0]).not.toContain('secret-token');
	});

	it('retries a 5xx or network error with backoff, then drops the post', async () => {
		const { sender, fetch, log } = setup([json(502, {}), new TypeError('fetch failed'), json(503, {})], {
			maxAttempts: 3,
		});
		sender.send(alertPost('boom'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetch).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('dropped a post after 3 tries'));
	});

	it('goes on with the queue after a retry succeeds', async () => {
		const { sender, bodies } = setup([json(500, {})]);
		sender.send(alertPost('boom'));
		sender.send(chat('Steve', 'after'));
		await vi.advanceTimersByTimeAsync(3000);
		expect(bodies().map(({ content }) => content)).toEqual(['boom', 'boom', 'after']);
	});

	it('drops the oldest chat lines when the queue overflows, never alerts', async () => {
		const { sender, bodies, log } = setup([], { maxQueued: 3 });
		sender.send(alertPost('alert one'));
		sender.send(chat('Steve', 'old'));
		sender.send(chat('Alex', 'middle'));
		sender.send(alertPost('alert two'));
		sender.send(chat('Steve', 'new'));
		await vi.advanceTimersByTimeAsync(1000);
		// With the chat between them dropped, the two alerts share a sender and batch.
		expect(bodies().map(({ content }) => content)).toEqual(['alert one\nalert two', 'new']);
		expect(log).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith('queue full: dropped 1 chat or join line');
	});

	it('posts what arrives while a delivery is under way, in order', async () => {
		const releases: Array<() => void> = [];
		const fetch = vi.fn<typeof globalThis.fetch>(
			() => new Promise<Response>((resolve) => releases.push(() => resolve(ok()))),
		);
		const sender = createSender({
			fallbackUsername: 'Survival',
			fetch,
			log: vi.fn(),
		});
		sender.send(chat('Steve', 'one'));
		await vi.advanceTimersByTimeAsync(1000);
		sender.send(chat('Alex', 'two'));
		sender.send(chat('Notch', 'three'));
		releases.shift()!();
		await vi.advanceTimersByTimeAsync(0);
		releases.shift()!();
		await vi.advanceTimersByTimeAsync(0);
		releases.shift()!();
		await vi.advanceTimersByTimeAsync(0);
		const contents = fetch.mock.calls.map(
			([, init]) => (JSON.parse(init!.body as string) as { content: string }).content,
		);
		expect(contents).toEqual(['one', 'two', 'three']);
	});

	it('drops a post after repeated 429s, waiting at least 100 ms even when told 0', async () => {
		const limited = Array.from({ length: 20 }, () => json(429, { retry_after: 0 }));
		const { sender, fetch, log } = setup(limited, { maxRateLimited: 3 });
		sender.send(alertPost('boom'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(99);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(log).toHaveBeenCalledWith('rate limited 3 times; dropped a post');
	});

	it('answers 401 like 404: that webhook is done', async () => {
		const { sender, fetch } = setup([json(401, { code: 50027 })]);
		sender.send(alertPost('first'));
		await vi.advanceTimersByTimeAsync(1000);
		sender.send(alertPost('second'));
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('times out a request that hangs and retries it', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				}),
		);
		const log = vi.fn();
		const sender = createSender({ fallbackUsername: 'Survival', fetch, log, requestTimeoutMs: 15_000, maxAttempts: 2 });
		sender.send(alertPost('boom'));
		await vi.advanceTimersByTimeAsync(1000 + 15_000);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(log).toHaveBeenCalledWith('request timed out; dropped a post after 2 tries');
	});

	it('gives up a 429 at once while closing, instead of waiting it out', async () => {
		const { sender, fetch, log } = setup([json(429, { retry_after: 30 })]);
		sender.send(alertPost('bye'));
		const closing = sender.close(60_000);
		await vi.advanceTimersByTimeAsync(0);
		await closing;
		expect(fetch).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith('rate limited 1 time; dropped a post');
	});

	it('aborts a request under way at the close deadline and ignores later sends', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				}),
		);
		const log = vi.fn();
		const sender = createSender({ fallbackUsername: 'Survival', fetch, log });
		sender.send(alertPost('stuck'));
		await vi.advanceTimersByTimeAsync(1000);
		const closing = sender.close(2000);
		await vi.advanceTimersByTimeAsync(2000);
		await closing;
		expect(log).toHaveBeenCalledWith('stopped with 1 post unsent');
		sender.send(alertPost('too late'));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stops posting to a malformed webhook URL, saying so once', async () => {
		const { sender, log, fetch } = setup();
		sender.send({ ...alertPost('boom'), webhook: 'not a url' });
		await vi.advanceTimersByTimeAsync(1000);
		sender.send({ ...alertPost('again'), webhook: 'not a url' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(log).toHaveBeenCalledExactlyOnceWith("webhook not a url isn't a valid URL; no posts go to it");
		sender.send(alertPost('still works'));
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('sends what is queued on close without waiting to batch', async () => {
		const { sender, bodies } = setup();
		sender.send(chat('Steve', 'bye'));
		const closing = sender.close(5000);
		await vi.advanceTimersByTimeAsync(0);
		await closing;
		expect(bodies().map(({ content }) => content)).toEqual(['bye']);
	});

	it('gives up on close after the timeout and says how much was unsent', async () => {
		const { sender, log } = setup([json(429, { retry_after: 60 })]);
		sender.send(alertPost('one'));
		sender.send(chat('Steve', 'two'));
		await vi.advanceTimersByTimeAsync(1000);
		const closing = sender.close(2000);
		await vi.advanceTimersByTimeAsync(2000);
		await closing;
		// The 429'd post in flight is unsent too.
		expect(log).toHaveBeenCalledWith('stopped with 2 posts unsent');
	});
});
