/** What a player's chat lines show as their picture in Discord. */
export type AvatarChoice =
	| { kind: 'skin' }
	| { kind: 'generated'; index?: number }
	| { kind: 'none' }
	| { kind: 'url'; url: string };

export interface AvatarConfig {
	default: AvatarChoice;
	/** By lowercased name: Minecraft names are unique regardless of case. */
	players: Map<string, AvatarChoice>;
}

/** The number of bundled pictures; adding more changes which one a hashed player gets. */
export const GENERATED_AVATARS = 10;

// Served from the public repository, so the helper needs no host of its own.
// The files exist only once merged to main.
const GENERATED_BASE = 'https://raw.githubusercontent.com/AlexLe08/shrimp-fried-this-rice/main/assets/mcbridge-avatars';

// mc-heads.net, not crafatar (unreliable, and it blocked Discord's image
// fetchers in 2024) or minotar (404 for an unknown name, where mc-heads
// answers with the default skin). 128 px covers Discord's high-DPI display.
const SKIN_BASE = 'https://mc-heads.net/avatar';
const SKIN_SIZE = 128;

/** Without an `avatars` key: players look different, and no name leaves for a skin service. */
export const DEFAULT_AVATARS: AvatarConfig = { default: { kind: 'generated' }, players: new Map() };

const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?([0-9a-f])[0-9a-f]{3}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * The picture's URL for a player's chat line, or undefined for the webhook's
 * own. `uuid` is the one the log gave on login, if the helper saw it.
 */
export function avatarFor(player: string, avatars: AvatarConfig, uuid?: string): string | undefined {
	const choice = avatars.players.get(player.toLowerCase()) ?? avatars.default;
	switch (choice.kind) {
		case 'none':
			return undefined;
		case 'url':
			return choice.url;
		case 'generated':
			return generatedUrl(choice.index ?? hashName(player));
		case 'skin': {
			if (uuid === undefined) {
				// Logged in before the helper started, so no UUID line was seen. The
				// name finds the same skin unless the server is in offline mode.
				return `${SKIN_BASE}/${player}/${SKIN_SIZE}`;
			}
			const match = UUID.exec(uuid);
			// Only a version 4 UUID is a Mojang account. Offline-mode servers make
			// version 3 ones from the name, which have no skin behind them; looking
			// the name up would show whoever owns it on Mojang's side.
			if (match?.[1] !== '4') return generatedUrl(hashName(player));
			return `${SKIN_BASE}/${uuid.replace(/-/g, '').toLowerCase()}/${SKIN_SIZE}`;
		}
	}
}

function generatedUrl(index: number): string {
	return `${GENERATED_BASE}/${index}.png`;
}

/** FNV-1a over the lowercased name: stable across restarts and versions of Node. */
export function hashName(player: string): number {
	let hash = 0x811c9dc5;
	for (const char of player.toLowerCase()) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % GENERATED_AVATARS;
}

/** Checks a config's `avatars`, adding what's wrong to `problems`. */
export function parseAvatars(raw: unknown, problems: string[]): AvatarConfig {
	if (raw === undefined) return DEFAULT_AVATARS;
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		problems.push('"avatars" must be an object with "default" and "players"');
		return DEFAULT_AVATARS;
	}
	const input = raw as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (key !== 'default' && key !== 'players') problems.push(`unknown key "avatars.${key}"`);
	}

	let fallback = DEFAULT_AVATARS.default;
	if (input.default !== undefined) {
		const choice = typeof input.default === 'string' ? parseChoice(input.default) : null;
		// A picked picture or URL for everyone would make every player look the same.
		if (choice && (choice.kind === 'skin' || choice.kind === 'none' || (choice.kind === 'generated' && choice.index === undefined))) {
			fallback = choice;
		} else {
			problems.push('"avatars.default" must be "skin", "generated" or "none"');
		}
	}

	const players = new Map<string, AvatarChoice>();
	if (input.players !== undefined) {
		if (typeof input.players !== 'object' || input.players === null || Array.isArray(input.players)) {
			problems.push('"avatars.players" must be an object of player names');
		} else {
			for (const [name, value] of Object.entries(input.players as Record<string, unknown>)) {
				if (!PLAYER_NAME.test(name)) {
					problems.push(`"avatars.players.${name}" isn't a Minecraft name (letters, digits and _, up to 16)`);
					continue;
				}
				if (players.has(name.toLowerCase())) {
					problems.push(`"avatars.players.${name}" is listed twice (names don't depend on case)`);
					continue;
				}
				const choice = typeof value === 'string' ? parseChoice(value) : null;
				if (choice) players.set(name.toLowerCase(), choice);
				else
					problems.push(
						`"avatars.players.${name}" must be "skin", "generated", "generated:0" to "generated:${GENERATED_AVATARS - 1}", "none" or an https image URL`,
					);
			}
		}
	}
	return { default: fallback, players };
}

function parseChoice(value: string): AvatarChoice | null {
	if (value === 'skin' || value === 'none') return { kind: value };
	if (value === 'generated') return { kind: 'generated' };
	const picked = /^generated:(\d+)$/.exec(value);
	if (picked) {
		const index = Number(picked[1]);
		return index < GENERATED_AVATARS ? { kind: 'generated', index } : null;
	}
	try {
		const url = new URL(value);
		// Discord's docs set no rule for avatar_url; https keeps a typo'd or
		// local address from being accepted and silently showing nothing.
		return url.protocol === 'https:' ? { kind: 'url', url: value } : null;
	} catch {
		return null;
	}
}
