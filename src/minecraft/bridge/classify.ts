import type { LogLevel } from './formats.ts';
import type { LogEntry } from './parseLine.ts';

export type AlertKind = 'error' | 'bind-failed' | 'lag' | 'crash';

export type BridgeEvent =
	| { type: 'started'; seconds: number }
	| { type: 'stopping' }
	| { type: 'joined'; player: string }
	| { type: 'left'; player: string }
	| { type: 'chat'; player: string; text: string }
	| {
			type: 'alert';
			kind: AlertKind;
			level: LogLevel;
			message: string;
			details: string[];
			/** A crash report's file name, shown with the alert but not part of what makes two alerts the same. */
			file?: string;
	  };

/**
 * Messages that are never an alert, whatever their level: routine anti-cheat
 * kicks a server owner can do nothing about. A config's `ignorePatterns`
 * add to this list.
 */
export const DEFAULT_IGNORE: readonly RegExp[] = [
	/was kicked for floating too long/,
	/moved too quickly!/,
	/moved wrongly!/,
];

export interface ClassifyOptions {
	ignore: readonly RegExp[];
}

// Vanilla usernames: letters, digits and underscores, at most 16 characters.
// Strict on purpose: the name becomes the Discord sender of a chat line.
const PLAYER = '([A-Za-z0-9_]{1,16})';

const STARTED = /^Done \((\d+(?:\.\d+)?)s\)! For help, type "help"$/;
// 26.3 prefixes join, leave and death lines with `System chat: `; older
// versions don't, so both are accepted.
const JOINED = new RegExp(`^(?:System chat: )?${PLAYER} joined the game$`);
const LEFT = new RegExp(`^(?:System chat: )?${PLAYER} left the game$`);
// Anchored at the start, so a player typing `<Admin> hi` is still themselves
// sending the text `<Admin> hi`. `[Not Secure]` marks a message without a
// chat signature.
const CHAT = new RegExp(`^(?:\\[Not Secure\\] )?<${PLAYER}> (.*)$`);
const BIND_FAILED = /FAILED TO BIND TO PORT/;
const LAG = /^Can't keep up! Is the server overloaded\?/;

/**
 * What a log entry means for Discord, or null for nothing. Pure: the rules
 * that depend on what came before (lag that repeats, duplicates) are in
 * `alertGate.ts`.
 */
export function classify(entry: LogEntry, options: ClassifyOptions): BridgeEvent | null {
	const { level, message } = entry;

	if (level === 'INFO') {
		const started = STARTED.exec(message);
		if (started) return { type: 'started', seconds: Number(started[1]) };
		if (message === 'Stopping server') return { type: 'stopping' };
		const joined = JOINED.exec(message);
		if (joined) return { type: 'joined', player: joined[1]! };
		const left = LEFT.exec(message);
		if (left) return { type: 'left', player: left[1]! };
		const chat = CHAT.exec(message);
		if (chat) return { type: 'chat', player: chat[1]!, text: chat[2]! };
		return null;
	}

	if (options.ignore.some((pattern) => pattern.test(message))) return null;

	if (level === 'WARN') {
		// Vanilla logs a port already in use at WARN, though the server can't come up.
		if (BIND_FAILED.test(message)) return alert('bind-failed', entry);
		if (LAG.test(message)) return alert('lag', entry);
		return null;
	}

	if (level === 'ERROR' || level === 'FATAL') return alert('error', entry);
	return null;
}

function alert(kind: AlertKind, entry: LogEntry): BridgeEvent {
	return { type: 'alert', kind, level: entry.level, message: entry.message, details: entry.details };
}
