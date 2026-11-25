import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseAvatars, type AvatarConfig } from './avatars.ts';
import { DEFAULT_IGNORE } from './classify.ts';
import { deriveKeys, isBridgeId } from './seal.ts';

export interface BridgeConfig {
	/** Shown in messages, and the sender name for everything but chat. */
	serverName: string;
	logPath: string;
	/** The server's crash-reports folder, watched for new reports; unset, crash reports aren't posted. */
	crashReportsDir?: string;
	webhooks: { chat: string; alerts: string };
	/** The built-in ignore list plus the config's `ignorePatterns`. */
	ignore: RegExp[];
	/** What each player's chat lines show as their picture. */
	avatars: AvatarConfig;
	/** The bot's endpoint, the bridge's id and the pairing secret, from the dashboard; unset, the bridge is one-way. */
	bot?: BotConfig;
}

export interface BotConfig {
	url: string;
	/** Sent in the clear with each sealed request, naming the bridge's keys. */
	bridge: string;
	secret: string;
}

const KEYS = new Set([
	'serverName',
	'logPath',
	'crashReportsDir',
	'format',
	'webhooks',
	'ignorePatterns',
	'avatars',
	'bot',
]);
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

/**
 * What's wrong with a server name, if anything. Pairing checks a name with
 * this too, so the dashboard never hands out a config the helper refuses.
 */
export function serverNameProblem(name: unknown): string | undefined {
	if (typeof name !== 'string' || name.trim() === '' || name.length > 80) {
		return '"serverName" must be a name of 1 to 80 characters';
	}
	// It's the name a post falls back to when Discord refuses a player's, and
	// Discord refuses these words in a webhook's name.
	if (/clyde|discord/i.test(name)) return '"serverName" can\'t contain "clyde" or "discord"';
	return undefined;
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

	const { serverName, logPath, crashReportsDir, format, webhooks, ignorePatterns, avatars, bot } = input;

	const nameProblem = serverNameProblem(serverName);
	if (nameProblem) problems.push(nameProblem);

	if (typeof logPath !== 'string' || logPath.trim() === '') {
		problems.push('"logPath" must be the path to the server\'s logs/latest.log');
	}

	if (crashReportsDir !== undefined && (typeof crashReportsDir !== 'string' || crashReportsDir.trim() === '')) {
		problems.push('"crashReportsDir" must be the path to the server\'s crash-reports folder');
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

	const avatarConfig = parseAvatars(avatars, problems);
	const botConfig = bot === undefined ? undefined : parseBot(bot, problems);

	if (problems.length) throw new ConfigError(problems);
	return {
		serverName: serverName as string,
		logPath: logPath as string,
		...(crashReportsDir === undefined ? {} : { crashReportsDir: crashReportsDir as string }),
		webhooks: urls,
		ignore,
		avatars: avatarConfig,
		...(botConfig === undefined ? {} : { bot: botConfig }),
	};
}

// What pairing in the dashboard wrote. Nothing reads it yet: the helper
// connects to the bot only once two-way chat is wired up.
function parseBot(bot: unknown, problems: string[]): BotConfig | undefined {
	if (typeof bot !== 'object' || bot === null || Array.isArray(bot)) {
		problems.push('"bot" must be an object with "url", "bridge" and "secret", as the dashboard gave it');
		return undefined;
	}
	const given = bot as Record<string, unknown>;
	const before = problems.length;
	for (const key of Object.keys(given)) {
		if (key !== 'url' && key !== 'bridge' && key !== 'secret') problems.push(`unknown key "bot.${key}"`);
	}
	const { url, bridge, secret } = given;
	if (!isBotUrl(url)) {
		problems.push('"bot.url" must be the https address the dashboard gave (http only on 127.0.0.1 or localhost)');
	}
	if (typeof bridge !== 'string' || !isBridgeId(bridge)) {
		problems.push('"bot.bridge" must be the bridge id the dashboard gave, unchanged');
	}
	// Never quoted back: it's the bridge's one credential.
	if (!isSecret(secret)) problems.push('"bot.secret" must be the secret the dashboard gave, unchanged');
	return problems.length === before
		? { url: url as string, bridge: bridge as string, secret: secret as string }
		: undefined;
}

function isBotUrl(url: unknown): boolean {
	if (typeof url !== 'string') return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
	// The seal hides what's said, but plain http elsewhere would still show
	// anyone on the way when and how much a server chats.
	return parsed.protocol === 'https:' || (local && parsed.protocol === 'http:');
}

function isSecret(secret: unknown): boolean {
	if (typeof secret !== 'string') return false;
	try {
		deriveKeys(secret);
		return true;
	} catch {
		return false;
	}
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		throw new ConfigError([`can't read ${path}: ${(error as Error).message}`]);
	}
	// Windows PowerShell 5 and some editors start a UTF-8 file with a byte order
	// mark, which JSON.parse refuses.
	if (text.startsWith('﻿')) text = text.slice(1);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		// Only where, not V8's message: it quotes the text around the mistake,
		// which may be part of a webhook's token.
		throw new ConfigError([`${path} isn't valid JSON${where(text, (error as Error).message)}`]);
	}
	const config = parseConfig(raw);
	// Relative to the config file, not to the working folder, which `npm run`
	// sets to the repository whatever folder it was typed in.
	const base = dirname(path);
	return {
		...config,
		logPath: resolve(base, config.logPath),
		...(config.crashReportsDir === undefined ? {} : { crashReportsDir: resolve(base, config.crashReportsDir) }),
	};
}

function where(text: string, message: string): string {
	const position = /position (\d+)/.exec(message);
	if (!position) return '';
	const before = text.slice(0, Number(position[1])).split('\n');
	return ` (line ${before.length}, column ${before.at(-1)!.length + 1})`;
}
