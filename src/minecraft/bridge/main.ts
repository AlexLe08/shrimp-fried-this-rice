// mcbridge: runs beside a Minecraft server and posts its start and stop,
// chat and real errors to Discord through webhooks (decision 0005). Run it
// with `npm run mcbridge -- --config mcbridge.json`; docs/MINECRAFT_BRIDGE.md
// covers setup. The bot never loads this file.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createBridge } from './bridge.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createCrashWatcher } from './crashReports.ts';
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

let config;
try {
	config = await loadConfig(configPath);
} catch (error) {
	console.error(`[mcbridge] ${error instanceof ConfigError ? error.message : String(error)}`);
	process.exit(1);
}

const sender = createSender({ fallbackUsername: config.serverName });
const bridge = createBridge({ config, sender });
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
	await Promise.all([tailer.stop(), crashWatcher?.stop()]);
	bridge.flush();
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
