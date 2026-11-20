import { describe, it, expect } from 'vitest';
import { Collection, type Client } from 'discord.js';
import { unusableEmojiWarning } from '../src/customEmoji.ts';

const HOME = { guildId: 'g1', useExternalEmojis: true };
const NO_EXTERNAL = { guildId: 'g1', useExternalEmojis: false };

function clientWith(emojis: { id: string; guildId: string; available?: boolean }[]): Client {
	const cache = new Collection(
		emojis.map((e) => [e.id, { id: e.id, available: e.available ?? true, guild: { id: e.guildId } }]),
	);
	return { emojis: { cache } } as unknown as Client;
}

const client = clientWith([
	{ id: '111', guildId: 'g1' },
	{ id: '222', guildId: 'g2' },
	{ id: '333', guildId: 'g1', available: false },
]);

describe('unusableEmojiWarning', () => {
	it('is null for text without custom emoji', () => {
		expect(unusableEmojiWarning(client, 'Drink water! 💧 :not_an_emoji:', HOME)).toBeNull();
	});

	it("is null for the server's own emoji", () => {
		expect(unusableEmojiWarning(client, 'hi <:shrimp:111>', NO_EXTERNAL)).toBeNull();
	});

	it("names an emoji from a server the bot isn't in", () => {
		const warning = unusableEmojiWarning(client, 'hi <:24pxPhantom_Dancer_Icon_2:1573329007896821812>', HOME);
		expect(warning).toContain("server I'm not in");
		expect(warning).toContain('`:24pxPhantom_Dancer_Icon_2:`');
	});

	it('matches animated emoji', () => {
		expect(unusableEmojiWarning(client, '<a:dance:999>', HOME)).toContain('`:dance:`');
	});

	it('names an emoji its server can no longer use', () => {
		expect(unusableEmojiWarning(client, '<:faded:333>', HOME)).toContain('Server Boost');
	});

	it('warns about an emoji from another server only without Use External Emojis', () => {
		expect(unusableEmojiWarning(client, '<:other:222>', HOME)).toBeNull();
		expect(unusableEmojiWarning(client, '<:other:222>', NO_EXTERNAL)).toContain('Use External Emojis');
	});

	it("doesn't guess when the channel's permissions are unknown", () => {
		expect(unusableEmojiWarning(client, '<:other:222>', { guildId: 'g1', useExternalEmojis: null })).toBeNull();
	});

	it("in a DM, needs only that the bot is in the emoji's server", () => {
		expect(unusableEmojiWarning(client, '<:other:222>', null)).toBeNull();
		expect(unusableEmojiWarning(client, '<:gone:999>', null)).toContain("server I'm not in");
	});

	it('ignores emoji in code, which shows as text anyway', () => {
		expect(unusableEmojiWarning(client, '`<:gone:999>` ```\n<:gone:999>\n```', HOME)).toBeNull();
	});

	it('warns about an emoji in a spoiler, which renders once revealed', () => {
		expect(unusableEmojiWarning(client, '||<:gone:999>||', HOME)).toContain('`:gone:`');
	});

	it('names a repeated emoji once, and each problem on its own line', () => {
		const warning = unusableEmojiWarning(client, '<:gone:999> <:gone:999> <:faded:333> <:other:222>', NO_EXTERNAL)!;
		expect(warning.match(/`:gone:`/g)).toHaveLength(1);
		expect(warning.split('\n')).toHaveLength(3);
	});
});
