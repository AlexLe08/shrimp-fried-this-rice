import { Events, type Guild } from 'discord.js';
import type { Event } from '../../core/types/event.ts';
import { deleteGuildMinecraftData } from '../storage.ts';

// discord.js emits this only when the bot leaves a server or the server is
// deleted; one lost to an outage is GuildUnavailable instead
// (client/actions/GuildDelete.js, 14.27), so an outage doesn't wipe its
// bridges. Links go too: decision 0007 promises one never outlives the bot's
// place in the server.
export default {
	name: Events.GuildDelete,
	execute(guild: Guild) {
		deleteGuildMinecraftData(guild.id);
	},
} satisfies Event<Events.GuildDelete>;
