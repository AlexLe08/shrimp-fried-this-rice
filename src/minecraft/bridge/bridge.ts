import { createAlertGate, type AlertGate } from './alertGate.ts';
import { classify } from './classify.ts';
import type { BridgeConfig } from './config.ts';
import { alertMessage, eventMessage, summaryMessage } from './messages.ts';
import { createEntryAssembler, parseLog, type LogEntry } from './parseLine.ts';
import type { Sender } from './sender.ts';

export interface BridgeOptions {
	config: BridgeConfig;
	sender: Pick<Sender, 'send'>;
	log?: (message: string) => void;
	gate?: AlertGate;
	/** How long the log stays quiet before a stack trace still collecting lines is posted. Defaults to 1 s. */
	quietMs?: number;
}

export interface Bridge {
	/** The tailer's backlog: scanned for whether the server is up, never posted. */
	onBacklog(text: string): void;
	onLines(lines: string[]): void;
	/** A log read error, posted as an alert: a helper that silently can't read its log would never be noticed. */
	onReadError(error: unknown): void;
	/** Posts the alert gate's counts, if any. The caller runs this every so often. */
	postSummaries(): void;
	/** Posts the entry still collecting lines, for shutdown. */
	flush(): void;
}

export function createBridge(options: BridgeOptions): Bridge {
	const { config, sender } = options;
	const log = options.log ?? ((message: string) => console.log(`[mcbridge] ${message}`));
	const gate = options.gate ?? createAlertGate();
	const quietMs = options.quietMs ?? 1000;
	const assembler = createEntryAssembler();
	let quietTimer: NodeJS.Timeout | null = null;

	function handle(entry: LogEntry): void {
		const event = classify(entry, { ignore: config.ignore });
		if (!event) return;
		if (event.type === 'alert') {
			const gated = gate.check(event, Date.now());
			if (gated)
				sender.send({ webhook: config.webhooks.alerts, droppable: false, ...alertMessage(gated, config.serverName) });
			return;
		}
		// Start and stop say whether the server is up, so they're kept when the
		// queue overflows; a lost chat or join line matters less.
		const droppable = event.type !== 'started' && event.type !== 'stopping';
		sender.send({ webhook: config.webhooks.chat, droppable, ...eventMessage(event, config.serverName) });
	}

	function flush(): void {
		if (quietTimer) clearTimeout(quietTimer);
		quietTimer = null;
		const entry = assembler.flush();
		if (entry) handle(entry);
	}

	return {
		onBacklog(text) {
			let up: boolean | null = null;
			for (const entry of parseLog(text)) {
				const event = classify(entry, { ignore: config.ignore });
				if (event?.type === 'started') up = true;
				else if (event?.type === 'stopping') up = false;
			}
			log(
				up === null
					? 'no start or stop in the existing log yet'
					: `the existing log says ${config.serverName} is ${up ? 'up' : 'stopped'}`,
			);
		},
		onLines(lines) {
			for (const line of lines) {
				const entry = assembler.push(line);
				if (entry) handle(entry);
			}
			// A stack trace has no end marker: the next prefixed line ends it, or
			// a moment of quiet.
			if (quietTimer) clearTimeout(quietTimer);
			quietTimer = setTimeout(flush, quietMs);
		},
		onReadError(error) {
			const reason = (error as NodeJS.ErrnoException).code ?? String(error);
			log(`can't read ${config.logPath}: ${String(error)}`);
			sender.send({
				webhook: config.webhooks.alerts,
				username: config.serverName,
				droppable: false,
				content: `⚠️ **${config.serverName}**: mcbridge can't read the server log (${reason}). Nothing is posted until it can.`,
			});
		},
		postSummaries() {
			const message = summaryMessage(gate.summaries(Date.now()), config.serverName);
			if (message) sender.send({ webhook: config.webhooks.alerts, droppable: false, ...message });
		},
		flush,
	};
}
