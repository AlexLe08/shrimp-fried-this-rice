import { vanilla, type LogFormat, type LogLine } from './formats.ts';

/** A log line with the unprefixed lines that followed it, such as a stack trace. */
export interface LogEntry extends LogLine {
	details: string[];
}

export type ParsedLine = { kind: 'line'; line: LogLine } | { kind: 'continuation'; text: string };

export function parseLine(raw: string, format: LogFormat = vanilla): ParsedLine {
	// A log written on Windows ends its lines with \r\n.
	const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
	const line = format.parse(text);
	return line ? { kind: 'line', line } : { kind: 'continuation', text };
}

export interface EntryAssembler {
	/** Takes the next line; returns the entry it completed, if any. */
	push(raw: string): LogEntry | null;
	/**
	 * Returns the entry still collecting lines. A stack trace has no end marker,
	 * so the tailer calls this when the log has been quiet for a moment.
	 */
	flush(): LogEntry | null;
}

export function createEntryAssembler(format: LogFormat = vanilla): EntryAssembler {
	let pending: LogEntry | null = null;
	return {
		push(raw) {
			const parsed = parseLine(raw, format);
			if (parsed.kind === 'continuation') {
				// Blank lines and output from before the first prefixed line belong to no entry.
				if (pending && parsed.text.trim() !== '') pending.details.push(parsed.text);
				return null;
			}
			const done = pending;
			pending = { ...parsed.line, details: [] };
			return done;
		},
		flush() {
			const done = pending;
			pending = null;
			return done;
		},
	};
}

/** Every entry in a whole log's text, for tests and the startup scan. */
export function parseLog(text: string, format: LogFormat = vanilla): LogEntry[] {
	const assembler = createEntryAssembler(format);
	const entries: LogEntry[] = [];
	for (const raw of text.split('\n')) {
		const done = assembler.push(raw);
		if (done) entries.push(done);
	}
	const last = assembler.flush();
	if (last) entries.push(last);
	return entries;
}
