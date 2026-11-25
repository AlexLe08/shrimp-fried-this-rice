import { GatewayIntentBits, Options, type ClientOptions } from 'discord.js';

// GuildExpressions keeps each server's emoji current after startup, so an
// emoji added since then isn't warned about as one the bot can't use.
// GuildMessages and MessageContent let it read bridges' chat channels for the
// Minecraft relay (decision 0006). Message Content is privileged: an app
// without it switched on in the Developer Portal is refused at login.
//
// No message is cached: by default discord.js keeps the last 200 of every
// channel, which with these intents would hold recent chat from every server
// in memory, though the relay promises to read only bridges' channels and
// keep nothing. Nothing reads that cache; the status embed fetches by id.
export const clientOptions: ClientOptions = {
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildExpressions,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
	makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }),
};
