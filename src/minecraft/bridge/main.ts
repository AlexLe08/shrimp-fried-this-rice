// mcbridge: runs beside a Minecraft server and posts its start and stop,
// chat and real errors to Discord through webhooks (decision 0005). Run it
// with `npm run mcbridge -- --config mcbridge.json`; docs/MINECRAFT_BRIDGE.md
// covers setup. The bot never loads this file.
import { parseArgs } from 'node:util';
import { createBridge } from './bridge.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createSender } from './sender.ts';
import { createTailer } from './tailer.ts';

const SUMMARY_INTERVAL_MS = 60_000;

let configPath: string | undefined;
try {
	({
		values: { config: configPath },
	} = parseArgs({ options: { config: { type: 'string' } } }));
} catch (error) {
	console.error(`[mcbridge] ${(error as Error).message}`);
}
if (!configPath) {
	console.error('[mcbridge] usage: npm run mcbridge -- --config <path to mcbridge.json>');
	process.exit(1);
}

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
const summaries = setInterval(bridge.postSummaries, SUMMARY_INTERVAL_MS);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log(`[mcbridge] ${signal}: posting what's left, then stopping`);
	// Posts still queued get up to 5 s; a Discord outage mustn't hold up a
	// restart or a host shutting down.
	const forceExit = setTimeout(() => process.exit(1), 10_000);
	forceExit.unref();
	clearInterval(summaries);
	await tailer.stop();
	bridge.flush();
	bridge.postSummaries();
	await sender.close(5000);
	process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => void shutdown(signal));
}

console.log(`[mcbridge] watching ${config.logPath} for ${config.serverName}`);
tailer.start();
