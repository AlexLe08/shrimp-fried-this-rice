export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/** One prefixed log line, normalised across server flavors. */
export interface LogLine {
	time: string;
	thread: string;
	level: LogLevel;
	/** Only flavors that print the logger (Forge, NeoForge) set it. */
	logger?: string;
	message: string;
}

export interface LogFormat {
	name: string;
	/** The line's parts, or null when the line has no prefix of this format (a stack trace line, say). */
	parse(line: string): LogLine | null;
}

// The thread is matched lazily up to the last `/LEVEL]`, as thread names can
// hold slashes themselves (`[RCON Client /0:0:0:0:0:0:0:1 #2/INFO]`).
const VANILLA_PREFIX = /^\[(\d{2}:\d{2}:\d{2})\] \[(.+?)\/(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]: (.*)$/;

/** Vanilla's `latest.log`, checked against a 26.3 server's log. */
export const vanilla: LogFormat = {
	name: 'vanilla',
	parse(line) {
		const match = VANILLA_PREFIX.exec(line);
		if (!match) return null;
		const [, time, thread, level, message] = match;
		return { time: time!, thread: thread!, level: level as LogLevel, message: message! };
	},
};
