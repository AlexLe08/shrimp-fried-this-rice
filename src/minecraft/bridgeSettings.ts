import { serverNameProblem } from './bridge/config.ts';
import { isColour, isPrefix } from './bridge/toMinecraft.ts';
import { getPlayerPictures, type DefaultPicture, type MinecraftBridge, type PlayerPicture } from './storage.ts';

// What the helper is told of its bridge's settings (the plan's A8, "Bot to
// helper"): with each connect, so a restart of either end refreshes them,
// and, from the dashboard (A8f), queued as a message when they change. The
// helper keeps the last ones in a cache file, so its posts keep their name
// and pictures while the bot is away. Linked players' pictures aren't here:
// links stay on the VM (decision 0007).

export interface BridgeSettings {
	kind: 'settings';
	serverName: string;
	prefix: string;
	colour: string;
	/** null: the helper's config decides. */
	defaultPicture: DefaultPicture | null;
	/** Set in the dashboard; they win over the config's for the same name. */
	pictures: { name: string; picture: PlayerPicture }[];
}

export function bridgeSettings(bridge: MinecraftBridge): BridgeSettings {
	return {
		kind: 'settings',
		serverName: bridge.server_name,
		prefix: bridge.prefix,
		colour: bridge.colour,
		defaultPicture: bridge.default_picture,
		pictures: getPlayerPictures(bridge.id).map(({ name, picture }) => ({ name, picture })),
	};
}

/** The settings a manager changes in the dashboard, as storage takes them. */
export interface SettingsChange {
	serverName: string;
	prefix: string;
	colour: string;
	/** null hands the default back to the helper's config. */
	defaultPicture: DefaultPicture | null;
}

export type SettingsField = keyof SettingsChange;

const DEFAULT_PICTURES: ReadonlySet<string> = new Set(['generated', 'skin', 'none'] satisfies DefaultPicture[]);

/**
 * Checks the settings form by the helper's own rules (bridge/settings.ts),
 * as the helper ignores a field it would refuse and keeps its config's:
 * saving one would show the manager a setting that never applies. Every
 * refused field is named, so the form can say all that's wrong at once.
 */
export function checkSettingsChange(form: {
	serverName: string;
	prefix: string;
	colour: string;
	defaultPicture: string;
}): { ok: true; change: SettingsChange } | { ok: false; refused: SettingsField[] } {
	const serverName = form.serverName.trim();
	const prefix = form.prefix.trim();
	// Hex colours mean the same in either case; named ones are lowercase only.
	const colour = form.colour.trim().toLowerCase();
	const picture = form.defaultPicture;

	const refused: SettingsField[] = [];
	if (serverNameProblem(serverName) !== undefined) refused.push('serverName');
	if (!isPrefix(prefix)) refused.push('prefix');
	if (!isColour(colour)) refused.push('colour');
	if (picture !== '' && !DEFAULT_PICTURES.has(picture)) refused.push('defaultPicture');
	if (refused.length > 0) return { ok: false, refused };
	return {
		ok: true,
		change: { serverName, prefix, colour, defaultPicture: picture === '' ? null : (picture as DefaultPicture) },
	};
}
