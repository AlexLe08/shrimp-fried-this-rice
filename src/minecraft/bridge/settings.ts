import { readFile, rename, writeFile } from 'node:fs/promises';
import { parseChoice, type AvatarChoice, type AvatarConfig } from './avatars.ts';
import { serverNameProblem, type BridgeConfig } from './config.ts';
import { DEFAULT_STYLE, isColour, isPrefix, type ChatStyle } from './toMinecraft.ts';

// The bridge's settings from the dashboard, which the bot sends with each
// connect (src/minecraft/bridgeSettings.ts). They win over the config file's,
// which are only the first values and the fallback (the plan's A8). The last
// ones are kept in a file beside the config, so posts keep their name and
// pictures while the bot is away or restarting.

/** What the bot sent, checked: a field missing here was absent or refused, and the config's stands. */
export interface ReceivedSettings {
	serverName?: string;
	prefix?: string;
	colour?: string;
	/** null: the dashboard leaves it to the config. */
	defaultPicture?: AvatarChoice | null;
	/** By lowercased name. */
	pictures?: Map<string, AvatarChoice>;
}

/** What the helper runs with: the config, with the dashboard's settings over it. */
export interface LiveSettings {
	serverName: string;
	style: ChatStyle;
	avatars: AvatarConfig;
}

const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

/** A name the helper takes a picture for; the dashboard checks with it too. */
export function isPlayerName(value: unknown): value is string {
	return typeof value === 'string' && PLAYER_NAME.test(value);
}

// The dashboard sets no links (the plan's A8): one arriving means something's wrong.
function picture(value: unknown): AvatarChoice | null {
	if (typeof value !== 'string') return null;
	const choice = parseChoice(value);
	return choice && choice.kind !== 'url' ? choice : null;
}

/** A picture the helper takes from the bot for a player; the dashboard checks with it too. */
export function isSettingsPicture(value: string): boolean {
	return picture(value) !== null;
}

/**
 * Checks what the bot sent, field by field: a field it would refuse in the
 * dashboard is dropped (and logged), so the rest still apply.
 */
export function readSettings(raw: unknown, log: (message: string) => void): ReceivedSettings | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const given = raw as Record<string, unknown>;
	const settings: ReceivedSettings = {};
	const refused: string[] = [];

	const { serverName, prefix, colour, defaultPicture, pictures } = given;
	// A field that's absent (a bot of another version) isn't refused, only not set.
	if (serverNameProblem(serverName) === undefined) settings.serverName = serverName as string;
	else if (serverName !== undefined) refused.push('serverName');
	if (typeof prefix === 'string' && isPrefix(prefix)) settings.prefix = prefix;
	else if (prefix !== undefined) refused.push('prefix');
	if (typeof colour === 'string' && isColour(colour)) settings.colour = colour;
	else if (colour !== undefined) refused.push('colour');
	if (defaultPicture === null) settings.defaultPicture = null;
	else if (defaultPicture !== undefined) {
		const choice = picture(defaultPicture);
		if (choice) settings.defaultPicture = choice;
		else refused.push('defaultPicture');
	}
	if (Array.isArray(pictures)) {
		const map = new Map<string, AvatarChoice>();
		for (const entry of pictures) {
			const { name, picture: value } = (entry ?? {}) as Record<string, unknown>;
			const choice = picture(value);
			if (isPlayerName(name) && choice) map.set(name.toLowerCase(), choice);
			else refused.push('a picture');
		}
		settings.pictures = map;
	} else if (pictures !== undefined) refused.push('pictures');

	if (refused.length > 0)
		log(`kept the config's values for settings the bot sent that aren't valid: ${refused.join(', ')}`);
	return settings;
}

/** The config with the dashboard's settings over it. */
export function applySettings(config: BridgeConfig, received: ReceivedSettings | null): LiveSettings {
	const players = new Map(config.avatars.players);
	for (const [name, choice] of received?.pictures ?? []) players.set(name, choice);
	return {
		serverName: received?.serverName ?? config.serverName,
		style: { prefix: received?.prefix ?? DEFAULT_STYLE.prefix, colour: received?.colour ?? DEFAULT_STYLE.colour },
		avatars: { default: received?.defaultPicture ?? config.avatars.default, players },
	};
}

/** `mcbridge.json` keeps its settings in `mcbridge.settings.json`, so two configs in one folder don't share one. */
export function settingsCachePath(configPath: string): string {
	return configPath.endsWith('.json') ? `${configPath.slice(0, -5)}.settings.json` : `${configPath}.settings.json`;
}

/**
 * The settings cached for this bridge, or null: none yet, another bridge's
 * (the config was paired again), or unreadable. Never fatal: the config's
 * values serve until the bot answers.
 */
export async function loadCachedSettings(
	path: string,
	bridgeId: string,
	log: (message: string) => void,
): Promise<ReceivedSettings | null> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`can't read ${path}: ${String(error)}`);
		return null;
	}
	let cached: unknown;
	try {
		cached = JSON.parse(text);
	} catch {
		log(`${path} isn't valid JSON; ignoring it until the bot sends the settings again`);
		return null;
	}
	const { bridge, settings } = (cached ?? {}) as Record<string, unknown>;
	if (bridge !== bridgeId) return null;
	return readSettings(settings, log);
}

let temporaryFiles = 0;

/**
 * Keeps what the bot sent, as it sent it, for the next start. Written to a
 * temporary file of its own and renamed over the old one, so a crash
 * mid-write leaves the old file, not half a new one.
 */
export async function saveSettings(path: string, bridgeId: string, settings: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${++temporaryFiles}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ bridge: bridgeId, settings }, null, 2)}\n`);
	await rename(temporary, path);
}

/**
 * Saves one at a time, in the order the bot sent them, so a connect answer
 * and a settings message close behind it can't finish out of order and
 * leave the older ones cached.
 */
export function createSettingsSaver(
	path: string,
	bridgeId: string,
	log: (message: string) => void,
): (settings: unknown) => Promise<void> {
	let last: Promise<void> = Promise.resolve();
	return (settings) => {
		last = last
			.then(() => saveSettings(path, bridgeId, settings))
			.catch((error: unknown) => log(`can't save the bridge settings to ${path}: ${String(error)}`));
		return last;
	};
}
