import { Events, type Message } from 'discord.js';
import type { Event } from '../../core/types/event.ts';
import { runningHelperHub } from '../../dashboard/server.ts';
import { relayMessage } from '../relay.ts';

// The bot receives every message in every server it's in (the GuildMessages
// and Message Content intents, decision 0006) and reads only bridges' chat
// channels. Without the dashboard's server there's no endpoint for a helper
// to poll, so nothing is queued.
export default {
	name: Events.MessageCreate,
	execute(message: Message) {
		const hub = runningHelperHub();
		if (hub) relayMessage(message, hub);
	},
} satisfies Event<Events.MessageCreate>;
