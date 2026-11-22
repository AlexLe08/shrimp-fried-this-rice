import { createConnection } from 'node:net';

// Packet layout and limits from minecraft.wiki's RCON page (checked 2026-11-22):
// little-endian int32 length (of the rest), request id and type, then the
// payload and two null bytes. The command limit is the wiki's, which it marks
// "outdated?"; the owner's end-to-end test (A8h) measures it on 26.3.
export const MAX_COMMAND_BYTES = 1446;
const TYPE_LOGIN = 3;
const TYPE_COMMAND = 2;
// id, type and the two null bytes
const MIN_LENGTH = 10;
// A reply's payload is at most 4096 bytes. Anything far larger isn't RCON
// (the wrong port, say), and must not make the helper buffer it.
const MAX_LENGTH = MIN_LENGTH + 64 * 1024;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export type RconErrorCode = 'login-refused' | 'timeout' | 'closed' | 'protocol';

export class RconError extends Error {
	readonly code: RconErrorCode;
	constructor(code: RconErrorCode, message: string) {
		super(message);
		this.name = 'RconError';
		this.code = code;
	}
}

export interface ConnectOptions {
	host: string;
	port: number;
	password: string;
	/** For connecting and logging in together, and for each command. Defaults to 5 s. */
	timeoutMs?: number;
	/** The connection closed without `close()` being called: the server stopped, or the network dropped it. */
	onClose?(error: RconError): void;
}

export interface RconConnection {
	/**
	 * Runs a command and resolves with the first packet of its reply (the rest
	 * of a split reply is dropped: `tellraw`, all the helper sends, has none).
	 * Throws for a command that isn't printable ASCII or is over
	 * `MAX_COMMAND_BYTES`: the `tellraw` builder escapes everything else, so
	 * such a command is a bug, and sending it would garble it.
	 */
	command(text: string): Promise<string>;
	close(): void;
}

interface Pending {
	resolve(body: string): void;
	reject(error: RconError): void;
	timer: NodeJS.Timeout;
}

export function checkCommand(text: string): void {
	if (!PRINTABLE_ASCII.test(text)) throw new TypeError('An RCON command must be printable ASCII');
	if (text.length > MAX_COMMAND_BYTES) {
		throw new RangeError(`An RCON command can be at most ${MAX_COMMAND_BYTES} bytes, not ${text.length}`);
	}
}

export function encodePacket(id: number, type: number, payload: string): Buffer {
	const body = Buffer.from(payload, 'latin1');
	const packet = Buffer.alloc(14 + body.length);
	packet.writeInt32LE(MIN_LENGTH + body.length, 0);
	packet.writeInt32LE(id, 4);
	packet.writeInt32LE(type, 8);
	body.copy(packet, 12);
	return packet;
}

/** Logs in, then resolves with the connection; rejects with an `RconError` (`login-refused` for a wrong password). */
export function connectRcon(options: ConnectOptions): Promise<RconConnection> {
	const timeoutMs = options.timeoutMs ?? 5000;
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: options.host, port: options.port });
		const pending = new Map<number, Pending>();
		let buffered: Buffer = Buffer.alloc(0);
		let nextId = 1;
		let loggedIn = false;
		let closed = false;

		// The server answers a wrong password with id -1, so ids stay positive.
		const takeId = () => {
			const id = nextId;
			nextId = nextId === 0x7fffffff ? 1 : nextId + 1;
			return id;
		};

		const loginId = takeId();
		const loginTimer = setTimeout(
			() => fail(new RconError('timeout', `no answer to the RCON login within ${timeoutMs} ms`)),
			timeoutMs,
		);

		function fail(error: RconError, expected = false): void {
			if (closed) return;
			closed = true;
			clearTimeout(loginTimer);
			socket.destroy();
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.reject(error);
			}
			pending.clear();
			if (!loggedIn) reject(error);
			else if (!expected) options.onClose?.(error);
		}

		function onPacket(id: number, body: string): void {
			if (!loggedIn) {
				if (id === -1) {
					fail(new RconError('login-refused', 'RCON refused the password (rcon.password in server.properties)'));
				} else if (id === loginId) {
					loggedIn = true;
					clearTimeout(loginTimer);
					resolve(connection);
				}
				return;
			}
			// A later fragment of a split reply finds nothing pending and is dropped.
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			clearTimeout(entry.timer);
			entry.resolve(body);
		}

		socket.on('connect', () => socket.write(encodePacket(loginId, TYPE_LOGIN, options.password)));
		socket.on('data', (chunk: Buffer) => {
			buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
			while (!closed && buffered.length >= 4) {
				const length = buffered.readInt32LE(0);
				if (length < MIN_LENGTH || length > MAX_LENGTH) {
					fail(new RconError('protocol', `not an RCON server: a packet of length ${length}`));
					return;
				}
				if (buffered.length < 4 + length) return;
				const id = buffered.readInt32LE(4);
				// latin1, as a server can send `§` as the single byte 0xA7.
				const body = buffered.toString('latin1', 12, 4 + length).replace(/\0+$/, '');
				buffered = buffered.subarray(4 + length);
				onPacket(id, body);
			}
		});
		// Without an 'error' listener, a refused or reset connection would crash the helper.
		socket.on('error', (error) => fail(new RconError('closed', `RCON connection failed: ${error.message}`)));
		socket.on('close', () => fail(new RconError('closed', 'RCON connection closed')));

		const connection: RconConnection = {
			command(text) {
				checkCommand(text);
				if (closed) return Promise.reject(new RconError('closed', 'RCON connection closed'));
				const id = takeId();
				return new Promise<string>((resolveCommand, rejectCommand) => {
					const timer = setTimeout(() => {
						pending.delete(id);
						rejectCommand(new RconError('timeout', `no answer to an RCON command within ${timeoutMs} ms`));
					}, timeoutMs);
					pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
					socket.write(encodePacket(id, TYPE_COMMAND, text));
				});
			},
			close() {
				fail(new RconError('closed', 'RCON connection closed'), true);
			},
		};
	});
}

export interface RconOptions {
	host: string;
	port: number;
	password: string;
	log?: (message: string) => void;
	/** Called once when the server refuses the password; the client then stays off until the helper restarts. */
	onLoginRefused?(): void;
	/** Defaults to 5 s. */
	timeoutMs?: number;
	/** The first reconnect's delay, doubling up to `maxBackoffMs`. Defaults to 1 s and 60 s. */
	minBackoffMs?: number;
	maxBackoffMs?: number;
	connect?: typeof connectRcon;
}

export interface Rcon {
	/** The server is up: connect, and reconnect whenever the connection drops. Does nothing if started, or after a refused password. */
	start(): void;
	/** The server is stopping: close the connection and stop reconnecting. */
	stop(): void;
	/**
	 * Runs a command, resolving `true` once the server answers. `false` means it
	 * was dropped: not started, not connected within the timeout, or failed
	 * twice. Rejects only for a command `checkCommand` refuses.
	 */
	send(command: string): Promise<boolean>;
}

export function createRcon(options: RconOptions): Rcon {
	const log = options.log ?? ((message: string) => console.error(`[mcbridge] ${message}`));
	const timeoutMs = options.timeoutMs ?? 5000;
	const minBackoffMs = options.minBackoffMs ?? 1000;
	const maxBackoffMs = options.maxBackoffMs ?? 60_000;
	const connect = options.connect ?? connectRcon;
	let running = false;
	let refused = false;
	// Each start() bumps it, so a connection attempt from before a stop() is discarded.
	let generation = 0;
	let backoffMs = minBackoffMs;
	let retryTimer: NodeJS.Timeout | null = null;
	let connection: RconConnection | null = null;
	const waiters = new Set<(connection: RconConnection | null) => void>();

	function wake(value: RconConnection | null): void {
		for (const waiter of [...waiters]) waiter(value);
	}

	function attempt(): void {
		retryTimer = null;
		const current = generation;
		connect({
			host: options.host,
			port: options.port,
			password: options.password,
			timeoutMs,
			onClose: (error) => {
				if (current !== generation) return;
				connection = null;
				log(`${error.message}; reconnecting`);
				retry();
			},
		}).then(
			(opened) => {
				if (current !== generation) {
					opened.close();
					return;
				}
				connection = opened;
				backoffMs = minBackoffMs;
				log(`RCON connected to ${options.host}:${options.port}`);
				wake(opened);
			},
			(error: unknown) => {
				if (current !== generation) return;
				if (error instanceof RconError && error.code === 'login-refused') {
					refused = true;
					running = false;
					log(`${error.message}; RCON stays off until mcbridge restarts`);
					wake(null);
					options.onLoginRefused?.();
					return;
				}
				log(`${error instanceof Error ? error.message : String(error)}; retrying in ${backoffMs / 1000} s`);
				retry();
			},
		);
	}

	function retry(): void {
		retryTimer = setTimeout(attempt, backoffMs);
		backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
	}

	function waitForConnection(): Promise<RconConnection | null> {
		if (connection) return Promise.resolve(connection);
		if (!running) return Promise.resolve(null);
		return new Promise((resolve) => {
			const done = (value: RconConnection | null) => {
				clearTimeout(timer);
				waiters.delete(done);
				resolve(value);
			};
			const timer = setTimeout(() => done(null), timeoutMs);
			waiters.add(done);
		});
	}

	return {
		start() {
			if (running || refused) return;
			running = true;
			generation++;
			backoffMs = minBackoffMs;
			attempt();
		},
		stop() {
			if (!running) return;
			running = false;
			generation++;
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = null;
			connection?.close();
			connection = null;
			wake(null);
		},
		async send(command) {
			checkCommand(command);
			for (let tries = 1; ; tries++) {
				const current = await waitForConnection();
				if (!current) return false;
				try {
					await current.command(command);
					return true;
				} catch (error) {
					// A timed-out command most likely reached a lagging server and will
					// still run, so sending it again would show it twice in game. One
					// cut off by a dropped connection most likely didn't run.
					const dropped = error instanceof RconError && error.code === 'closed';
					if (!dropped || tries >= 2) {
						log(`dropped an RCON command: ${error instanceof Error ? error.message : String(error)}`);
						return false;
					}
				}
			}
		},
	};
}
