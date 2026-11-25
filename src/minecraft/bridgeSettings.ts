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
