import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HelperHub,
	LEASE_MS,
	MAX_HELD_MESSAGES,
	MAX_MESSAGES_PER_POLL,
	MESSAGE_HOLD_MS,
	POLL_HOLD_MS,
	type PollResult,
} from '../../src/minecraft/helperHub.ts';

const BRIDGE = 'bridge-1';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/** Whether the promise has settled yet, without waiting for it. */
async function settled(promise: Promise<PollResult>): Promise<PollResult | 'pending'> {
	return Promise.race([promise, Promise.resolve('pending' as const)]);
}

const none: PollResult = { kind: 'messages', messages: [] };

describe('HelperHub', () => {
	it('answers a poll at once with the messages already waiting, in order', async () => {
		const hub = new HelperHub();
		const session = hub.connect(BRIDGE);
		hub.deliver(BRIDGE, 'one');
		hub.deliver(BRIDGE, { text: 'two' });

		await expect(hub.poll(BRIDGE, session)).resolves.toEqual({ kind: 'messages', messages: ['one', { text: 'two' }] });
		// Each message goes once.
		const next = hub.poll(BRIDGE, session);
		expect(await settled(next)).toBe('pending');
	});

	it('holds a poll until a message comes, answering with it at once', async () => {
		const hub = new HelperHub();
		const session = hub.connect(BRIDGE);
		const poll = hub.poll(BRIDGE, session);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await settled(poll)).toBe('pending');
		expect(hub.__isPollHeldForTests(BRIDGE)).toBe(true);

		hub.deliver(BRIDGE, 'hello');

		await expect(settled(poll)).resolves.toEqual({ kind: 'messages', messages: ['hello'] });
		expect(hub.__isPollHeldForTests(BRIDGE)).toBe(false);
	});

	it('answers a held poll with nothing after POLL_HOLD_MS, inside the lease and Cloudflare’s 125 s', async () => {
		expect(POLL_HOLD_MS).toBeLessThan(LEASE_MS);
		expect(POLL_HOLD_MS).toBeLessThan(125_000);
		const hub = new HelperHub();
		const poll = hub.poll(BRIDGE, hub.connect(BRIDGE));

		await vi.advanceTimersByTimeAsync(POLL_HOLD_MS - 1);
		expect(await settled(poll)).toBe('pending');
		await vi.advanceTimersByTimeAsync(1);
		expect(await settled(poll)).toEqual(none);
	});

	it('keeps a message for MESSAGE_HOLD_MS while no poll is open, then drops it', async () => {
		const hub = new HelperHub();
		const session = hub.connect(BRIDGE);
		hub.deliver(BRIDGE, 'kept');
		await vi.advanceTimersByTimeAsync(MESSAGE_HOLD_MS - 1);
		await expect(hub.poll(BRIDGE, session)).resolves.toEqual({ kind: 'messages', messages: ['kept'] });

		hub.deliver(BRIDGE, 'dropped');
		await vi.advanceTimersByTimeAsync(MESSAGE_HOLD_MS);
		expect(await settled(hub.poll(BRIDGE, session))).toBe('pending');
	});

	it('keeps a message held longer even after an earlier one is dropped', async () => {
		const hub = new HelperHub();
		const session = hub.connect(BRIDGE);
		hub.deliver(BRIDGE, 'short');
		hub.deliver(BRIDGE, 'long', 2 * 60_000);
		hub.deliver(BRIDGE, 'short again');
		await vi.advanceTimersByTimeAsync(MESSAGE_HOLD_MS);

		await expect(hub.poll(BRIDGE, session)).resolves.toEqual({ kind: 'messages', messages: ['long'] });
	});

	it('holds messages for a helper that hasn’t connected yet, as after a reconnect', async () => {
		const hub = new HelperHub();
		hub.deliver(BRIDGE, 'early');

		await expect(hub.poll(BRIDGE, hub.connect(BRIDGE))).resolves.toEqual({ kind: 'messages', messages: ['early'] });
	});

	it('drops messages past MAX_HELD_MESSAGES, saying so', async () => {
		const hub = new HelperHub();
		const session = hub.connect(BRIDGE);
		for (let i = 0; i < MAX_HELD_MESSAGES; i++) expect(hub.deliver(BRIDGE, i)).toBe(true);

		expect(hub.deliver(BRIDGE, 'one too many')).toBe(false);

		const seen: unknown[] = [];
		while (seen.length < MAX_HELD_MESSAGES) {
			const result = await hub.poll(BRIDGE, session);
			if (result.kind !== 'messages') throw new Error(result.kind);
			expect(result.messages.length).toBeLessThanOrEqual(MAX_MESSAGES_PER_POLL);
			seen.push(...result.messages);
		}
		expect(seen).toEqual([...Array(MAX_HELD_MESSAGES).keys()]);
	});

	it('keeps each bridge’s messages to its own helper', async () => {
		const hub = new HelperHub();
		const mine = hub.connect(BRIDGE);
		const theirs = hub.connect('bridge-2');
		hub.deliver('bridge-2', 'theirs');

		expect(await settled(hub.poll(BRIDGE, mine))).toBe('pending');
		await expect(hub.poll('bridge-2', theirs)).resolves.toEqual({ kind: 'messages', messages: ['theirs'] });
	});

	describe('one helper per bridge', () => {
		it('gives each connection its own session', () => {
			const hub = new HelperHub();
			const first = hub.connect(BRIDGE);
			const second = hub.connect(BRIDGE);

			expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
			expect(second).not.toBe(first);
		});

		it('lets a new connection take over, answering the old one’s held poll and every later poll as taken over', async () => {
			const hub = new HelperHub();
			const old = hub.connect(BRIDGE);
			const held = hub.poll(BRIDGE, old);

			const current = hub.connect(BRIDGE);

			await expect(held).resolves.toEqual({ kind: 'taken-over' });
			await expect(hub.poll(BRIDGE, old)).resolves.toEqual({ kind: 'taken-over' });
			hub.deliver(BRIDGE, 'for the new one');
			await expect(hub.poll(BRIDGE, current)).resolves.toEqual({
				kind: 'messages',
				messages: ['for the new one'],
			});
		});

		it('ends a session LEASE_MS after its last poll ended, with none open', async () => {
			const hub = new HelperHub();
			const session = hub.connect(BRIDGE);
			hub.deliver(BRIDGE, 'x');
			await hub.poll(BRIDGE, session);
			await vi.advanceTimersByTimeAsync(LEASE_MS);
			hub.deliver(BRIDGE, 'y');
			// Just inside: the lease is counted from the end of the last poll.
			await expect(hub.poll(BRIDGE, session)).resolves.toEqual({ kind: 'messages', messages: ['y'] });

			await vi.advanceTimersByTimeAsync(LEASE_MS + 1);

			await expect(hub.poll(BRIDGE, session)).resolves.toEqual({ kind: 'session-ended' });
			// Ended for good: it connects again.
			await expect(hub.poll(BRIDGE, session)).resolves.toEqual({ kind: 'session-ended' });
		});

		it('counts the lease from when a held poll is answered, not from when it was made', async () => {
			const hub = new HelperHub();
			const session = hub.connect(BRIDGE);
			await vi.advanceTimersByTimeAsync(LEASE_MS - 1);
			const held = hub.poll(BRIDGE, session);
			await vi.advanceTimersByTimeAsync(POLL_HOLD_MS);
			await expect(held).resolves.toEqual(none);

			await vi.advanceTimersByTimeAsync(LEASE_MS);

			expect(await settled(hub.poll(BRIDGE, session))).toBe('pending');
		});

		it('ends a session it doesn’t know, as after a restart, rather than calling it taken over', async () => {
			const hub = new HelperHub();

			await expect(hub.poll(BRIDGE, 'from-before-the-restart')).resolves.toEqual({ kind: 'session-ended' });
		});

		it('lets a taken-over helper connect again once the newer one’s lease has lapsed', async () => {
			const hub = new HelperHub();
			const old = hub.connect(BRIDGE);
			hub.connect(BRIDGE);
			await vi.advanceTimersByTimeAsync(LEASE_MS + 1);

			await expect(hub.poll(BRIDGE, old)).resolves.toEqual({ kind: 'session-ended' });
		});

		it('answers an earlier poll of the same session with nothing when it polls again', async () => {
			const hub = new HelperHub();
			const session = hub.connect(BRIDGE);
			const first = hub.poll(BRIDGE, session);

			const second = hub.poll(BRIDGE, session);

			await expect(first).resolves.toEqual(none);
			hub.deliver(BRIDGE, 'to the second');
			await expect(second).resolves.toEqual({ kind: 'messages', messages: ['to the second'] });
		});
	});

	describe('a helper hanging up', () => {
		it('answers its held poll with nothing, leaving later messages for the next poll', async () => {
			const hub = new HelperHub();
			const session = hub.connect(BRIDGE);
			const controller = new AbortController();
			const held = hub.poll(BRIDGE, session, controller.signal);

			controller.abort();

			await expect(held).resolves.toEqual(none);
			expect(hub.__isPollHeldForTests(BRIDGE)).toBe(false);
			hub.deliver(BRIDGE, 'not lost');
			await expect(hub.poll(BRIDGE, session)).resolves.toEqual({ kind: 'messages', messages: ['not lost'] });
		});

		it('takes no messages for a poll already abandoned', async () => {
			const hub = new HelperHub();
			const session = hub.connect(BRIDGE);
			const controller = new AbortController();
			controller.abort();

			await expect(hub.poll(BRIDGE, session, controller.signal)).resolves.toEqual(none);
			expect(hub.__isPollHeldForTests(BRIDGE)).toBe(false);
		});
	});

	describe('close', () => {
		it('answers every held poll with nothing, and later polls at once', async () => {
			const hub = new HelperHub();
			const one = hub.poll(BRIDGE, hub.connect(BRIDGE));
			const other = hub.connect('bridge-2');
			const two = hub.poll('bridge-2', other);

			hub.close();

			await expect(one).resolves.toEqual(none);
			await expect(two).resolves.toEqual(none);
			expect(await settled(hub.poll('bridge-2', other))).toEqual(none);
		});

		it('still hands over messages already waiting', async () => {
			const hub = new HelperHub();
			const session = hub.connect(BRIDGE);
			hub.deliver(BRIDGE, 'last one');
			hub.close();

			await expect(hub.poll(BRIDGE, session)).resolves.toEqual({ kind: 'messages', messages: ['last one'] });
		});
	});
});
