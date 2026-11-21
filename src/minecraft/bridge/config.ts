import { readFile } from 'node:fs/promises';
import { DEFAULT_IGNORE } from './classify.ts';

export interface BridgeConfig {
	/** Shown in messages, and the sender name for everything but chat. */
	serverName: string;
	logPath: string;
	webhooks: { chat: string; alerts: string };
	/** The built-in ignore list plus the config's `ignorePatterns`. */
	ignore: RegExp[];
}

const KEYS = new Set(['serverName', 'logPath', 'format', 'webhooks', 'ignorePatterns']);
// discord.com, or the older discordapp.com, with the PTB and Canary clients'
// hosts; an optional API version; then the webhook's id and token.
const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;

export class ConfigError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(`invalid config:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
		this.problems = problems;
	}
}

/** Checks a parsed config file, reporting every problem at once. */
export function parseConfig(raw: unknown): BridgeConfig {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new ConfigError(['the config must be a JSON object']);
	}
	const input = raw as Record<string, unknown>;
	const problems: string[] = [];

	// A misspelt key would otherwise be ignored without a word, and so would one
	// for a feature not built yet.
	for (const key of Object.keys(input)) {
		if (!KEYS.has(key)) problems.push(`unknown key "${key}"`);
	}

	const { serverName, logPath, format, webhooks, ignorePatterns } = input;

	if (typeof serverName !== 'string' || serverName.trim() === '' || serverName.length > 80) {
		problems.push('"serverName" must be a name of 1 to 80 characters');
	} else if (/clyde|discord/i.test(serverName)) {
		// It's the name a post falls back to when Discord refuses a player's, and
		// Discord refuses these words in a webhook's name.
		problems.push('"serverName" can\'t contain "clyde" or "discord"');
	}

	if (typeof logPath !== 'string' || logPath.trim() === '') {
		problems.push('"logPath" must be the path to the server\'s logs/latest.log');
	}

	if (format !== undefined && format !== 'vanilla') {
		problems.push('"format" can only be "vanilla" for now');
	}

	const urls = { chat: '', alerts: '' };
	if (typeof webhooks !== 'object' || webhooks === null || Array.isArray(webhooks)) {
		problems.push('"webhooks" must be an object with "chat" and "alerts" webhook URLs');
	} else {
		const given = webhooks as Record<string, unknown>;
		for (const key of Object.keys(given)) {
			if (key !== 'chat' && key !== 'alerts') problems.push(`unknown key "webhooks.${key}"`);
		}
		for (const name of ['chat', 'alerts'] as const) {
			const url = given[name];
			if (typeof url === 'string' && WEBHOOK_URL.test(url)) urls[name] = url;
			else problems.push(`"webhooks.${name}" must be a Discord webhook URL (https://discord.com/api/webhooks/…)`);
		}
	}

	const ignore = [...DEFAULT_IGNORE];
	if (ignorePatterns !== undefined) {
		if (!Array.isArray(ignorePatterns)) {
			problems.push('"ignorePatterns" must be a list of regular expressions');
		} else {
			ignorePatterns.forEach((pattern: unknown, index) => {
				if (typeof pattern !== 'string') {
					problems.push(`"ignorePatterns[${index}]" must be a string`);
					return;
				}
				try {
					// No flags: `test` on a g or y regex is stateful and would skip
					// every other match.
					ignore.push(new RegExp(pattern));
				} catch (error) {
					problems.push(`"ignorePatterns[${index}]" isn't a valid regular expression: ${(error as Error).message}`);
				}
			});
		}
	}

	if (problems.length) throw new ConfigError(problems);
	return { serverName: serverName as string, logPath: logPath as string, webhooks: urls, ignore };
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		throw new ConfigError([`can't read ${path}: ${(error as Error).message}`]);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new ConfigError([`${path} isn't valid JSON: ${(error as Error).message}`]);
	}
	return parseConfig(raw);
}
