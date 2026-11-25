// mcbridge: runs beside a Minecraft server and posts its start and stop,
// chat and real errors to Discord through webhooks (decision 0005). Run it
// with `npm run mcbridge -- --config mcbridge.json`; docs/MINECRAFT_BRIDGE.md
// covers setup. The bot never loads this file.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createBotClient, type StopReason } from './botClient.ts';
import { createBridge } from './bridge.ts';
import { ConfigError, loadConfig, serverPropertiesPathOf, type BridgeConfig } from './config.ts';
import { createCrashWatcher } from './crashReports.ts';
import { createGameRelay } from './gameRelay.ts';
import { escapeMarkdown } from './messages.ts';
import { createSender } from './sender.ts';
import { createTailer } from './tailer.ts';

const SUMMARY_INTERVAL_MS = 60_000;

let configArg: string | undefined;
try {
	({
		values: { config: configArg },
	} = parseArgs({ options: { config: { type: 'string' } } }));
} catch (error) {
	console.error(`[mcbridge] ${(error as Error).message}`);
}
if (!configArg) {
	console.error('[mcbridge] usage: npm run mcbridge -- --config <path to mcbridge.json>');
	process.exit(1);
}
// `npm run` starts this in the repository folder; INIT_CWD is where the
// command was typed, which is what a relative path means to whoever typed it.
const configPath = resolve(process.env['INIT_CWD'] ?? process.cwd(), configArg);

let config: BridgeConfig;
try {
	config = await loadConfig(configPath);
} catch (error) {
	console.error(`[mcbridge] ${error instanceof ConfigError ? error.message : String(error)}`);
	process.exit(1);
}

const sender = createSender({ fallbackUsername: config.serverName });

// Problems only the server's owner can fix, in the alerts channel like the helper's others.
function postAlert(text: string): void {
	sender.send({
		webhook: config.webhooks.alerts,
		username: config.serverName,
		droppable: false,
		content: `⚠️ **${escapeMarkdown(config.serverName)}**: ${text}`,
	});
}

const STOPPED: Record<StopReason, string> = {
	'taken-over':
		"another mcbridge connected with this bridge's secret, so this one stopped taking messages from Discord. Stop the other copy, or restart this one to take two-way chat back.",
	unauthorized:
		"the bot no longer accepts this bridge's secret: it was regenerated, or the bridge removed, in the dashboard. Download the new mcbridge.json and restart mcbridge; until then messages from Discord don't reach the game.",
};

// Two-way chat (decision 0006), only once paired: without `bot` the helper is
// today's one-way bridge, unchanged.
const game = config.bot
	? createGameRelay({
			propertiesPath: serverPropertiesPathOf(config),
			...(config.rcon ? { rconOverride: config.rcon } : {}),
			alert: (_reason, message) => postAlert(message),
		})
	: null;
const botClient =
	config.bot && game
		? createBotClient({
				bot: config.bot,
				onChat: (chat) => game.relay(chat),
				onStopped: (reason) => {
					console.error(`[mcbridge] two-way chat stopped: ${reason}`);
					postAlert(STOPPED[reason]);
				},
			})
		: null;
const bridge = createBridge({ config, sender, ...(game ? { game } : {}) });
const tailer = createTailer({
	path: config.logPath,
	onLines: bridge.onLines,
	onBacklog: bridge.onBacklog,
	onError: bridge.onReadError,
});
const crashWatcher = config.crashReportsDir
	? createCrashWatcher({
			dir: config.crashReportsDir,
			onReport: bridge.onCrashReport,
			onError: bridge.onCrashReportError,
		})
	: null;
const summaries = setInterval(() => bridge.postSummaries(), SUMMARY_INTERVAL_MS);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
	if (stopping) {
		// A second Ctrl+C: the user doesn't want to wait for the queue.
		process.exit(1);
	}
	stopping = true;
	console.log(`[mcbridge] ${signal}: posting what's left, then stopping (again to stop now)`);
	// Posts still queued get up to 5 s; a Discord outage mustn't hold up a
	// restart or a host shutting down.
	const forceExit = setTimeout(() => process.exit(1), 10_000);
	forceExit.unref();
	clearInterval(summaries);
	await Promise.all([tailer.stop(), crashWatcher?.stop(), botClient?.stop()]);
	// After the flush: a start or stop still held by the log's assembler is
	// handled first, so a stop line still reads whether chat was on.
	bridge.flush();
	game?.close();
	bridge.postSummaries({ final: true });
	await sender.close(5000);
	process.exit(0);
}

// Windows never delivers SIGTERM. Closing the console window raises SIGHUP
// (Windows ends the process about 10 s later) and Ctrl+Break raises SIGBREAK.
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
for (const signal of signals) {
	process.on(signal, () => void shutdown(signal));
}

console.log(`[mcbridge] watching ${config.logPath} for ${config.serverName}`);
if (!existsSync(config.logPath)) {
	// Not an error, and not posted: a new server has no log until it first
	// starts. But a mistyped logPath looks exactly like this, forever.
	console.warn(
		`[mcbridge] ${config.logPath} doesn't exist yet; waiting for it. If the server has run before, check logPath.`,
	);
}
if (config.crashReportsDir) {
	console.log(`[mcbridge] watching ${config.crashReportsDir} for new crash reports`);
}
tailer.start();
crashWatcher?.start();
if (botClient) {
	console.log(`[mcbridge] two-way chat: connecting to ${new URL(config.bot!.url).origin}`);
	botClient.start();
}
