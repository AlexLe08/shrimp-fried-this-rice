import { Events, type Client } from 'discord.js';
import type { Event } from '../../core/types/event.ts';
import { runningHelperHub } from '../../dashboard/server.ts';
import { catchUpBridges } from '../catchUp.ts';

// Once per process: the gateway doesn't replay what the bot missed while it
// was down, so bridges catch up from the API (decision 0010). A reconnect
// later in the run that resumes its session gets the missed events replayed;
// one that has to start a new session isn't caught up (decision 0010 covers
// restarts).
export default {
	name: Events.ClientReady,
	once: true,
	execute(client: Client<true>) {
		return catchUpBridges(client, runningHelperHub());
	},
} satisfies Event<Events.ClientReady>;
