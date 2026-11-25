import { randomBytes } from 'node:crypto';

// What the bot holds for each paired helper between its long polls (the
// plan's A8, "The helper's connection to the bot"): who holds the bridge's
// lease, the messages waiting for it, and the poll it has open. Memory only:
// a restart drops all of it, and the helper connects again.

/**
 * How long a poll is held before it's answered with no messages: inside
 * Cloudflare's 125 s limit on an answer (error 524) and the lease below.
 */
export const POLL_HOLD_MS = 50_000;
/** A session lapses this long after its last poll ended, with none open. */
export const LEASE_MS = 60_000;
/** How long a message waits for the helper's next poll before it's dropped. */
export const MESSAGE_HOLD_MS = 30_000;
// 5 a second for 30 s, the most the relay lets into the game (A8e), with room.
export const MAX_HELD_MESSAGES = 200;
// Keeps one answer's sealed body small; the rest go with the next poll.
export const MAX_MESSAGES_PER_POLL = 50;

export type PollResult =
	| { kind: 'messages'; messages: unknown[] }
	/** Another helper connected with this bridge's secret since: this one stops. */
	| { kind: 'taken-over' }
	/** The session lapsed, or the bot restarted since: the helper connects again. */
	| { kind: 'session-ended' };

interface HeldPoll {
	session: string;
	answer: (result: PollResult) => void;
}

interface BridgeState {
	session: string | null;
	leaseEndsAt: number;
	held: HeldPoll | null;
	queue: { message: unknown; expiresAt: number }[];
}

export class HelperHub {
	readonly #now: () => number;
	readonly #bridges = new Map<string, BridgeState>();
	#closed = false;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/**
	 * Starts a session for the bridge, taking the lease over from any other: a
	 * helper restarted after a crash needn't wait for its old lease to lapse,
	 * and the older of two copies is the one that stops.
	 */
	connect(bridgeId: string): string {
		const state = this.#state(bridgeId);
		state.held?.answer({ kind: 'taken-over' });
		state.session = randomBytes(16).toString('base64url');
		state.leaseEndsAt = this.#now() + LEASE_MS;
		return state.session;
	}

	/**
	 * Answers with the messages waiting, or holds the poll until one arrives or
	 * POLL_HOLD_MS passes. If `signal` aborts (the helper hung up), it's answered
	 * with none, leaving any message for the next poll.
	 */
	poll(bridgeId: string, session: string, signal?: AbortSignal): Promise<PollResult> {
		const state = this.#bridges.get(bridgeId);
		if (!state || state.session !== session) {
			return Promise.resolve(state && this.#isLive(state) ? { kind: 'taken-over' } : { kind: 'session-ended' });
		}
		if (!this.#isLive(state)) {
			state.session = null;
			return Promise.resolve({ kind: 'session-ended' });
		}
		// The same helper polling again while its last poll is still open here,
		// as when its connection dropped without the bot noticing.
		state.held?.answer({ kind: 'messages', messages: [] });

		// Before taking any: a helper that hung up while its request was read
		// would never get them.
		if (signal?.aborted) {
			this.#endPoll(state, session);
			return Promise.resolve({ kind: 'messages', messages: [] });
		}
		const ready = this.#take(state);
		if (ready.length > 0 || this.#closed) {
			this.#endPoll(state, session);
			return Promise.resolve({ kind: 'messages', messages: ready });
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => held.answer({ kind: 'messages', messages: [] }), POLL_HOLD_MS);
			const onAbort = () => held.answer({ kind: 'messages', messages: [] });
			const held: HeldPoll = {
				session,
				answer: (result) => {
					clearTimeout(timer);
					signal?.removeEventListener('abort', onAbort);
					if (state.held === held) state.held = null;
					this.#endPoll(state, session);
					resolve(result);
				},
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			state.held = held;
		});
	}

	/**
	 * Queues a message for the bridge's helper, answering its open poll at
	 * once. False if it was dropped because too many are waiting.
	 */
	deliver(bridgeId: string, message: unknown, holdMs = MESSAGE_HOLD_MS): boolean {
		const state = this.#state(bridgeId);
		this.#dropExpired(state);
		if (state.queue.length >= MAX_HELD_MESSAGES) return false;
		state.queue.push({ message, expiresAt: this.#now() + holdMs });
		state.held?.answer({ kind: 'messages', messages: this.#take(state) });
		return true;
	}

	/** Whether shutdown has closed it: the database may be closing too. */
	get closed(): boolean {
		return this.#closed;
	}

	/**
	 * For shutdown: answers every open poll now, and any later one at once,
	 * so the server isn't left waiting on polls held for up to 50 s.
	 */
	close(): void {
		this.#closed = true;
		for (const state of this.#bridges.values()) state.held?.answer({ kind: 'messages', messages: [] });
	}

	/** Test-only: whether the bridge has a poll held open. Not used in application code. */
	__isPollHeldForTests(bridgeId: string): boolean {
		return this.#bridges.get(bridgeId)?.held != null;
	}

	#state(bridgeId: string): BridgeState {
		let state = this.#bridges.get(bridgeId);
		if (!state) {
			state = { session: null, leaseEndsAt: 0, held: null, queue: [] };
			this.#bridges.set(bridgeId, state);
		}
		return state;
	}

	// A poll held open keeps the lease, however long ago the last one ended.
	#isLive(state: BridgeState): boolean {
		return state.session !== null && (state.held?.session === state.session || this.#now() <= state.leaseEndsAt);
	}

	// The lease runs from the end of the last poll, as the plan has it.
	#endPoll(state: BridgeState, session: string): void {
		if (state.session === session) state.leaseEndsAt = this.#now() + LEASE_MS;
	}

	#take(state: BridgeState): unknown[] {
		this.#dropExpired(state);
		return state.queue.splice(0, MAX_MESSAGES_PER_POLL).map((held) => held.message);
	}

	// Not by position: a caller may hold one message longer than those before it.
	#dropExpired(state: BridgeState): void {
		const now = this.#now();
		state.queue = state.queue.filter((held) => held.expiresAt > now);
	}
}
