import { readFile as readFileFromDisk } from 'node:fs/promises';
import type { BotChat } from './botClient.ts';
import type { RconOverride } from './config.ts';
import { createRcon, type Rcon } from './rcon.ts';
import { decodeServerProperties, parseProperties, serverSettings, type RconOffReason } from './serverProperties.ts';
import { DEFAULT_STYLE, chatCommand, type ChatStyle } from './toMinecraft.ts';

// Discord to Minecraft, the helper's end (decision 0006; the plan's A8, "The
// relay"): chat from the bot goes into the game as `tellraw @a` over RCON,
// whose settings the server reads from server.properties only as it starts,
// so they're read again at each start. Chat sent while the server is down is
// dropped, not queued (the owner's call).

/** Into the game at most this many a second, in order: a catch-up after a bot restart hands over up to 20 at once. */
export const GAME_CHAT_PER_SECOND = 5;
/** Chat waiting to go in; past it, newer chat is dropped. At 5 a second, 10 s of it: more would be too old by its turn. */
export const MAX_QUEUED_CHAT = 50;
/** Chat older than this when its turn comes is dropped: while RCON can't connect, it would go in minutes late, out of context. */
export const MAX_CHAT_AGE_MS = 10_000;
export const MIN_PASSWORD_LENGTH = 12;
const MIN_DISTINCT_CHARACTERS = 5;
// Letters made only of these, in any case and order, are guessed first.
const COMMON_WORDS = /^(?:minecraft|password|changeme|admin|rcon|server|qwerty|letmein)+$/;

/** Why RCON's password is refused, or null if it's fine. Never the password itself, which alerts would quote. */
export function weakPasswordReason(password: string): string | null {
	const characters = [...password];
	if (characters.length < MIN_PASSWORD_LENGTH) return `it's under ${MIN_PASSWORD_LENGTH} characters`;
	if (new Set(characters).size < MIN_DISTINCT_CHARACTERS) return 'it repeats a few characters';
	const letters = password.toLowerCase().replace(/[^a-z]/g, '');
	if (letters !== '' && COMMON_WORDS.test(letters)) return "it's built from common words";
	return null;
}

export type RelayOffReason =
	| RconOffReason
	| 'unreadable'
	| 'malformed'
	| 'weak-password'
	| 'login-refused'
	/** Not off: RCON keeps trying, and chat goes in once it connects. */
	| 'unreachable';

export interface GameRelayOptions {
	propertiesPath: string;
	rconOverride?: RconOverride;
	/** A problem the server's owner must fix, posted as an alert; once per reason per run of the helper. */
	alert: (reason: RelayOffReason, message: string) => void;
	log?: (message: string) => void;
	readFile?: (path: string) => Promise<Uint8Array>;
	createRcon?: typeof createRcon;
}

export interface GameRelay {
	/** The server started, or the helper found it running: read server.properties again and connect. */
	serverUp(): Promise<void>;
	/** The server is stopping: disconnect, and drop chat waiting to go in. */
	serverDown(): void;
	/** Chat from Discord: into the game in order, at most 5 a second; dropped while the server is down or RCON is off. */
	relay(chat: BotChat[], style?: ChatStyle): void;
	/**
	 * Whether two-way chat was set up at the server's last start: RCON enabled
	 * with a strong password, and not refused since. Kept through serverDown,
	 * so the stop message can read it either side of it. It doesn't say RCON
	 * is connected.
	 */
	isOn(): boolean;
	/**
	 * `online-mode` as read at the server's last start; null before a read
	 * succeeds, or after one fails. Linking reads null as offline: unclear is
	 * never proof.
	 */
	onlineMode(): boolean | null;
	/** The helper is stopping. */
	close(): void;
}

export function createGameRelay(options: GameRelayOptions): GameRelay {
	const log = options.log ?? ((message: string) => console.error(`[mcbridge] ${message}`));
	const readFile = options.readFile ?? readFileFromDisk;
	const makeRcon = options.createRcon ?? createRcon;
	const path = options.propertiesPath;

	let up = false;
	let on = false;
	let onlineMode: boolean | null = null;
	let rcon: Rcon | null = null;
	// Each start or stop bumps it, so a read finishing after the server stopped is dropped.
	let generation = 0;
	const alerted = new Set<RelayOffReason>();
	let queue: { command: string; queuedAt: number }[] = [];
	let pumping = false;
	let dropped = 0;

	function off(reason: RelayOffReason, message: string): void {
		on = false;
		log(`two-way chat is off: ${message}`);
		alertOnce(reason, message);
	}

	function alertOnce(reason: RelayOffReason, message: string): void {
		if (alerted.has(reason)) return;
		alerted.add(reason);
		options.alert(reason, message);
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// One command at a time (RCON's own rule, rcon.ts), each start at least
	// 1/5 s after the last, so a burst goes in at the normal rate, in order.
	async function pump(): Promise<void> {
		if (pumping) return;
		pumping = true;
		try {
			while (queue.length > 0 && rcon && on) {
				const { command, queuedAt } = queue.shift()!;
				const startedAt = Date.now();
				if (startedAt - queuedAt > MAX_CHAT_AGE_MS) {
					dropped++;
					continue;
				}
				const run = generation;
				let sent: boolean;
				try {
					sent = await rcon.send(command);
				} catch (error) {
					// A command RCON refuses outright (chatCommand keeps within its
					// limits): dropped, and the helper goes on.
					log(`skipped a message RCON refused: ${(error as Error).message}`);
					sent = false;
				}
				// One cut off by the server stopping is expected, not a fault.
				if (!sent && run === generation) dropped++;
				const rest = 1000 / GAME_CHAT_PER_SECOND - (Date.now() - startedAt);
				if (rest > 0) await sleep(rest);
			}
		} finally {
			pumping = false;
			if (dropped > 0) {
				log(`${dropped} message(s) from Discord couldn't be sent to the game`);
				dropped = 0;
			}
		}
	}

	return {
		async serverUp() {
			const run = ++generation;
			up = true;
			on = false;
			rcon?.stop();
			rcon = null;

			let bytes: Uint8Array;
			try {
				bytes = await readFile(path);
			} catch (error) {
				if (run !== generation) return;
				onlineMode = null;
				const code = (error as NodeJS.ErrnoException).code ?? String(error);
				off(
					'unreadable',
					`mcbridge can't read ${path} (${code}), so messages from Discord can't reach the game. If it's elsewhere, set "serverPropertiesPath" in mcbridge.json.`,
				);
				return;
			}
			if (run !== generation) return;

			let settings: ReturnType<typeof serverSettings>;
			try {
				settings = serverSettings(parseProperties(decodeServerProperties(bytes)));
			} catch (error) {
				// A broken escape, such as `\u12`: the server would read it differently, so nothing is guessed.
				onlineMode = null;
				off(
					'malformed',
					`mcbridge can't read ${path} (${(error as Error).message}), so messages from Discord can't reach the game. Fix the file, then restart the server.`,
				);
				return;
			}
			onlineMode = settings.onlineMode;
			if (!settings.rcon.enabled) {
				off(settings.rcon.reason, rconOffMessage(settings.rcon.reason));
				return;
			}
			const weak = weakPasswordReason(settings.rcon.password);
			if (weak) {
				off(
					'weak-password',
					`rcon.password in server.properties is too easy to guess (${weak}). RCON sends it unencrypted, and whoever reaches the port gets the server's console, so messages from Discord don't go in. Set one of ${MIN_PASSWORD_LENGTH} or more characters, with at least ${MIN_DISTINCT_CHARACTERS} different ones, that isn't made of common words, then restart the server.`,
				);
				return;
			}

			const host = options.rconOverride?.host ?? '127.0.0.1';
			const port = options.rconOverride?.port ?? settings.rcon.port;
			const connection = makeRcon({
				host,
				port,
				password: settings.rcon.password,
				log,
				onLoginRefused: () =>
					off(
						'login-refused',
						'the server refused rcon.password, so messages from Discord can\'t reach the game. If it was changed while the server ran, restart the server, which reads it only as it starts; if "rcon" in mcbridge.json points at another server, fix it and restart mcbridge.',
					),
				onUnreachable: () => {
					const message = `RCON hasn't answered on ${host}:${port} for 2 minutes, so messages from Discord aren't reaching the game. In Docker, publish the port on 127.0.0.1 and set "rcon" in mcbridge.json to it; with server-ip set, put that address in "rcon". mcbridge keeps trying.`;
					log(message);
					alertOnce('unreachable', message);
				},
			});
			rcon = connection;
			on = true;
			connection.start();
			log('two-way chat is on: messages from Discord go into the game');
		},

		serverDown() {
			generation++;
			up = false;
			rcon?.stop();
			rcon = null;
			// Not queued for the next start (the owner's call): the stop message says so.
			queue = [];
		},

		relay(chat, style = DEFAULT_STYLE) {
			if (!up || !on) return;
			for (const { name, text } of chat) {
				let command: string | null;
				try {
					command = chatCommand(name, text, style);
				} catch (error) {
					log(`skipped a message from Discord: ${(error as Error).message}`);
					continue;
				}
				if (!command) continue;
				if (queue.length >= MAX_QUEUED_CHAT) {
					dropped++;
					continue;
				}
				queue.push({ command, queuedAt: Date.now() });
			}
			void pump();
		},

		isOn: () => on,
		onlineMode: () => onlineMode,

		close() {
			generation++;
			up = false;
			on = false;
			rcon?.stop();
			rcon = null;
			queue = [];
		},
	};
}

function rconOffMessage(reason: RconOffReason): string {
	const restart = 'then restart the server, which reads it only as it starts.';
	switch (reason) {
		case 'disabled':
			return `RCON is off in server.properties, so messages from Discord can't reach the game. Set enable-rcon=true and a long rcon.password, ${restart}`;
		case 'no-password':
			return `rcon.password in server.properties is empty, so the server doesn't start RCON and messages from Discord can't reach the game. Set a long one, ${restart}`;
		case 'bad-port':
			return `rcon.port in server.properties isn't a port number (1 to 65535), so messages from Discord can't reach the game. Fix it, ${restart}`;
	}
}
