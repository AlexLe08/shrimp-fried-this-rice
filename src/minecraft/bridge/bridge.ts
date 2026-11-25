import { avatarFor, isMojangUuid } from './avatars.ts';
import { createAlertGate, type AlertGate } from './alertGate.ts';
import { classify, type BridgeEvent } from './classify.ts';
import type { BridgeConfig } from './config.ts';
import { parseCrashReport } from './crashReports.ts';
import { alertMessage, escapeMarkdown, eventMessage, summaryMessage } from './messages.ts';
import { createEntryAssembler, parseLog, type LogEntry } from './parseLine.ts';
import type { Sender } from './sender.ts';

/** A player's `!link` code, for the bot to check against the one it gave (decision 0007). */
export interface LinkReport {
	player: string;
	code: string;
	/** From this run's login line; without it the bot answers "log in again and retry". */
	uuid: string | undefined;
	onlineMode: boolean;
}

export interface BridgeOptions {
	config: BridgeConfig;
	sender: Pick<Sender, 'send'>;
	/**
	 * Set only once the bridge is paired with the bot (A8e). Until then a
	 * `!link` line is posted as the chat it looks like, so a one-way bridge
	 * behaves as before.
	 */
	link?: {
		report(link: LinkReport): void;
		/** `online-mode` from `server.properties`, as read at the server's last start. */
		onlineMode(): boolean;
	};
	/**
	 * Two-way chat's way into the game (gameRelay.ts), set only once paired:
	 * told when the server starts and stops, as RCON follows the server.
	 */
	game?: {
		serverUp(): Promise<void>;
		serverDown(): void;
		/** Whether chat from Discord was reaching the game, for the stop message's second line. */
		isOn(): boolean;
	};
	log?: (message: string) => void;
	gate?: AlertGate;
	/** How long the log stays quiet before a stack trace still collecting lines is posted. Defaults to 1 s. */
	quietMs?: number;
	/** At most one "can't read the log" (or crash-reports folder) alert per this long. Defaults to 10 minutes. */
	readErrorEveryMs?: number;
}

export interface Bridge {
	/** The tailer's backlog: scanned for whether the server is up, never posted. */
	onBacklog(text: string): void;
	onLines(lines: string[]): void;
	/** A log read error, posted as an alert: a helper that silently can't read its log would never be noticed. */
	onReadError(error: unknown): void;
	/**
	 * Posts the alert gate's counts, if any. The caller runs this every so
	 * often, and once with `final` on shutdown, which also reports repeats
	 * whose window hasn't ended.
	 */
	postSummaries(options?: { final?: boolean }): void;
	/** A new crash report, posted as an alert through the gate, so a server crashing on every restart posts a count, not every crash. */
	onCrashReport(file: string, text: string): void;
	/** The crash-reports folder can't be listed: posted like a log read error, or crashes would go unreported unnoticed. */
	onCrashReportError(error: unknown): void;
	/** Posts the entry still collecting lines, for shutdown. */
	flush(): void;
}

export function createBridge(options: BridgeOptions): Bridge {
	const { config, sender } = options;
	const log = options.log ?? ((message: string) => console.log(`[mcbridge] ${message}`));
	const gate = options.gate ?? createAlertGate();
	const quietMs = options.quietMs ?? 1000;
	const readErrorEveryMs = options.readErrorEveryMs ?? 10 * 60_000;
	const assembler = createEntryAssembler();
	let quietTimer: NodeJS.Timeout | null = null;
	// Per thing that can't be read (the log, the crash-reports folder).
	const lastReadErrorPost = new Map<string, number>();
	// By lowercased name, for the server's run: not dropped on leaving, as a
	// player logging in again while online logs the new UUID before the old
	// session's leave line.
	const uuids = new Map<string, string>();
	let offlineMode = false;

	function track(event: BridgeEvent): void {
		if (event.type === 'uuid') {
			uuids.set(event.player.toLowerCase(), event.uuid);
			if (!isMojangUuid(event.uuid)) offlineMode = true;
		} else if (event.type === 'stopping' || event.type === 'started') {
			// A crash logs no stop; a start begins a new run either way, and the
			// server's online-mode setting may have changed with it.
			uuids.clear();
			offlineMode = false;
		}
	}

	// The callbacks run from the tailer and from timers: a bug in one must log,
	// not stop the helper (an exception thrown from a timer would end it).
	function guarded<Args extends unknown[]>(name: string, run: (...args: Args) => void) {
		return (...args: Args): void => {
			try {
				run(...args);
			} catch (error) {
				log(`${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			}
		};
	}

	// Its own failures are alerts already; anything else is a bug to log, never
	// an unhandled rejection, which would end the helper.
	function gameUp(): void {
		options.game?.serverUp().catch((error: unknown) => log(`starting two-way chat failed: ${String(error)}`));
	}

	function postAlert(alert: Extract<BridgeEvent, { type: 'alert' }>): void {
		const gated = gate.check(alert, Date.now());
		if (gated) {
			sender.send({ webhook: config.webhooks.alerts, droppable: false, ...alertMessage(gated, config.serverName) });
		}
	}

	function readError(path: string, what: string, consequence: string, error: unknown): void {
		const reason = (error as NodeJS.ErrnoException).code ?? String(error);
		log(`can't read ${path}: ${String(error)}`);
		// The tailer reports an error again whenever one follows a good read, so
		// a flaky disk or share could otherwise post one every poll.
		const now = Date.now();
		if (now - (lastReadErrorPost.get(what) ?? -Infinity) < readErrorEveryMs) return;
		lastReadErrorPost.set(what, now);
		sender.send({
			webhook: config.webhooks.alerts,
			username: config.serverName,
			droppable: false,
			content: `⚠️ **${escapeMarkdown(config.serverName)}**: mcbridge can't read ${what} (${reason}). ${consequence}`,
		});
	}

	function handle(entry: LogEntry): void {
		const classified = classify(entry, { ignore: config.ignore });
		if (!classified) return;
		track(classified);
		if (classified.type === 'uuid') return;
		let event: Exclude<BridgeEvent, { type: 'link' }>;
		if (classified.type === 'link') {
			if (options.link) {
				// Never relayed while paired, malformed or not: the code is the
				// player's proof, and only the bot should see it.
				const { player, code } = classified;
				if (code !== null) {
					options.link.report({
						player,
						code,
						uuid: uuids.get(player.toLowerCase()),
						onlineMode: options.link.onlineMode(),
					});
				}
				return;
			}
			event = { type: 'chat', player: classified.player, text: classified.text };
		} else {
			event = classified;
		}
		if (event.type === 'alert') {
			postAlert(event);
			return;
		}
		// Start and stop say whether the server is up, so they're kept when the
		// queue overflows; a lost chat or join line matters less.
		const droppable = event.type !== 'started' && event.type !== 'stopping';
		const message = eventMessage(event, config.serverName);
		if (event.type === 'stopping' && options.game?.isOn()) {
			// Dropped, not queued, while it's down (the owner's call), so say so where people post.
			message.content += "\nMessages sent here won't reach the game until it's back.";
		}
		if (event.type === 'chat') {
			const avatarUrl = avatarFor(event.player, config.avatars, {
				uuid: uuids.get(event.player.toLowerCase()),
				offlineMode,
			});
			if (avatarUrl) message.avatarUrl = avatarUrl;
		}
		sender.send({ webhook: config.webhooks.chat, droppable, ...message });
		if (event.type === 'started') gameUp();
		else if (event.type === 'stopping') options.game?.serverDown();
	}

	const flush = guarded('flushing the last entry', () => {
		if (quietTimer) clearTimeout(quietTimer);
		quietTimer = null;
		const entry = assembler.flush();
		if (entry) handle(entry);
	});

	return {
		onBacklog: guarded('scanning the existing log', (text: string) => {
			let up: boolean | null = null;
			for (const entry of parseLog(text)) {
				const event = classify(entry, { ignore: config.ignore });
				// Players already online when the helper starts keep their UUID.
				if (event) track(event);
				if (event?.type === 'started') up = true;
				else if (event?.type === 'stopping') up = false;
			}
			log(
				up === null
					? 'no start or stop in the existing log yet'
					: `the existing log says ${config.serverName} is ${up ? 'up' : 'stopped'}`,
			);
			// When it can't tell, RCON is tried anyway: it waits and retries, so a
			// server that is in fact stopped costs only some log lines.
			if (up !== false) gameUp();
		}),
		onLines: guarded('reading new lines', (lines: string[]) => {
			// A stack trace has no end marker: the next prefixed line ends it, or
			// a moment of quiet. Re-armed first, so a bug below can't leave an
			// entry unflushed.
			if (quietTimer) clearTimeout(quietTimer);
			quietTimer = setTimeout(flush, quietMs);
			for (const line of lines) {
				try {
					const entry = assembler.push(line);
					if (entry) handle(entry);
				} catch (error) {
					log(`skipped a log line after an error: ${String(error)}`);
				}
			}
		}),
		onReadError: guarded('reporting a read error', (error: unknown) => {
			readError(config.logPath, 'the server log', 'Nothing is posted until it can.', error);
		}),
		onCrashReport: guarded('posting a crash report', (file: string, text: string) => {
			const { description, exception } = parseCrashReport(text);
			postAlert({
				type: 'alert',
				kind: 'crash',
				level: 'FATAL',
				message: description ?? 'A new crash report (no description in it)',
				details: exception,
				file,
			});
		}),
		onCrashReportError: guarded('reporting a crash-reports read error', (error: unknown) => {
			readError(
				config.crashReportsDir ?? 'crashReportsDir',
				'the crash-reports folder',
				"Crashes aren't posted until it can.",
				error,
			);
		}),
		postSummaries: guarded('posting summaries', ({ final = false }: { final?: boolean } = {}) => {
			const message = summaryMessage(gate.summaries(final ? Infinity : Date.now()), config.serverName);
			if (message) sender.send({ webhook: config.webhooks.alerts, droppable: false, ...message });
		}),
		flush,
	};
}
