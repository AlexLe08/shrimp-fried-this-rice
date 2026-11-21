import { describe, it, expect, vi } from 'vitest';
import { DiscordAPIError, MessageFlags } from 'discord.js';
import {
	CODE,
	discordTime,
	fitLines,
	fitTo,
	isRefusedByDiscord,
	replyEphemeral,
	DISCORD_MESSAGE_LIMIT,
} from '../../src/core/discord.ts';

function discordError(code: number, status: number): DiscordAPIError {
	return new DiscordAPIError({ message: 'mock', code }, code, status, 'POST', 'https://discord.com/api/v10/mock', {});
}

describe('replyEphemeral', () => {
	it('replies with the content, visible only to the user', async () => {
		const interaction = { reply: vi.fn().mockResolvedValue(undefined) };
		await replyEphemeral(interaction as never, 'hi');
		expect(interaction.reply).toHaveBeenCalledWith({ content: 'hi', flags: MessageFlags.Ephemeral });
	});
});

describe('discordTime', () => {
	it('builds a timestamp in whole seconds, rounded down', () => {
		expect(discordTime(1_700_000_000_999, 'R')).toBe('<t:1700000000:R>');
		expect(discordTime(1_700_000_000_000, 'f')).toBe('<t:1700000000:f>');
	});
});

describe('fitLines', () => {
	it('joins every line when they fit', () => {
		expect(fitLines(['a', 'b', 'c'], 5)).toBe('a\nb\nc');
	});

	it('leaves out the lines that do not fit and says how many', () => {
		expect(fitLines(['aaa', 'bbb', 'ccc'], 10, { more: (n) => `+${n}` })).toBe('aaa\nbbb+1');
	});

	it('counts the "more" text towards the limit', () => {
		// 'aaa\nbbb' fits in 8 alone, but not with '+1' after it.
		expect(fitLines(['aaa', 'bbb', 'ccc'], 8, { more: (n) => `+${n}` })).toBe('aaa+2');
	});

	it('returns only the "more" text when no line fits', () => {
		expect(fitLines(['aaaaaa', 'b'], 3, { more: (n) => `+${n}` })).toBe('+2');
	});

	it('stops at the limit without a "more" text', () => {
		expect(fitLines(['aa', 'bb', 'cc'], 6, { separator: ' ' })).toBe('aa bb');
	});

	it('returns an empty string for no lines', () => {
		expect(fitLines([], 10, { more: (n) => `+${n}` })).toBe('');
	});

	it('uses the Discord message limit of 2000 characters', () => {
		expect(DISCORD_MESSAGE_LIMIT).toBe(2000);
	});
});

describe('fitTo', () => {
	it('returns text that fits unchanged', () => {
		expect(fitTo('abc', 3)).toBe('abc');
	});

	it('cuts to the limit, ellipsis included', () => {
		expect(fitTo('abcdef', 4)).toBe('abc…');
	});

	it('never cuts an emoji in half', () => {
		// '😀' is two UTF-16 units: with room for one before the ellipsis, it's dropped whole.
		expect(fitTo('a😀b', 3)).toBe('a…');
	});
});

describe('isRefusedByDiscord', () => {
	it('is true for a 4xx answer from Discord', () => {
		expect(isRefusedByDiscord(discordError(50013, 403))).toBe(true);
		expect(isRefusedByDiscord(discordError(50007, 400))).toBe(true);
	});

	it('is false for a rate limit, a server error or another error', () => {
		expect(isRefusedByDiscord(discordError(0, 429))).toBe(false);
		expect(isRefusedByDiscord(discordError(0, 500))).toBe(false);
		expect(isRefusedByDiscord(new Error('socket hang up'))).toBe(false);
	});
});

describe('CODE', () => {
	it('matches inline code and code blocks, not plain text', () => {
		expect('a `b` c ```d\ne``` f'.match(CODE)).toEqual(['`b`', '```d\ne```']);
	});
});
