import type { ClientEvents } from 'discord.js';

// Generic over the event's name so `satisfies Event<Events.X>` checks that a
// handler takes the arguments discord.js emits for that event.
export interface Event<Name extends keyof ClientEvents = keyof ClientEvents> {
	name: Name;
	once?: boolean;
	execute(...args: ClientEvents[Name]): unknown;
}
