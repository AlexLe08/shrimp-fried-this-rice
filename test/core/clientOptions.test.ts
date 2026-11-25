import { describe, expect, it } from 'vitest';
import { GatewayIntentBits, IntentsBitField, Message, MessageManager } from 'discord.js';
import { clientOptions } from '../../src/core/clientOptions.ts';

describe('clientOptions', () => {
	it('asks for the intents the relay reads bridge channels with, Message Content among them', () => {
		const intents = new IntentsBitField(clientOptions.intents);
		// By bits: toArray() also names GuildExpressions by its old alias.
		expect(
			intents.equals([
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildExpressions,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
			]),
		).toBe(true);
	});

	it("caches no message, so other servers' chat isn't held in memory", () => {
		const cache = clientOptions.makeCache!(MessageManager as never, Message as never, MessageManager as never);
		cache.set('1', {} as never);
		expect(cache.size).toBe(0);
	});
});
