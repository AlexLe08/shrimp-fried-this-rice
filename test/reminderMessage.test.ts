import { describe, it, expect } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import { buildReminderMessage } from '../src/reminderMessage.ts';

function build(text: string) {
	const message = buildReminderMessage('water', text, 60);
	return { content: message.content, embed: (message.embeds?.[0] as EmbedBuilder).toJSON() };
}

describe('buildReminderMessage', () => {
	it('puts the text in an embed titled with the label, with the interval in the footer', () => {
		const { content, embed } = build('Drink water!');

		expect(content).toBeUndefined();
		expect(embed.title).toBe('water');
		expect(embed.description).toBe('Drink water!');
		expect(embed.footer?.text).toBe('Every 60 minutes');
		expect(embed.color).toBeTypeOf('number');
	});

	it('repeats user, role, @everyone and @here mentions outside the embed so they ping', () => {
		const { content, embed } = build('<@123> <@!456> <@&789> @everyone @here time to raid');

		expect(content).toBe('<@123> <@!456> <@&789> @everyone @here');
		expect(embed.description).toBe('<@123> <@!456> <@&789> @everyone @here time to raid');
	});

	it("leaves channel mentions in the embed only, since they don't ping", () => {
		expect(build('see <#123>').content).toBeUndefined();
	});

	it('repeats links outside the embed so they preview, without trailing punctuation', () => {
		expect(build('Watch https://youtu.be/abc. Then https://x.com/a?b=1!').content).toBe(
			'https://youtu.be/abc https://x.com/a?b=1',
		);
	});

	it('takes the link out of a markdown link', () => {
		expect(build('[the guide](https://example.com/guide)').content).toBe('https://example.com/guide');
	});

	it('skips links in angle brackets, which asked for no preview', () => {
		expect(build('quiet <https://example.com> link').content).toBeUndefined();
	});

	it('lists a repeated mention or link once', () => {
		expect(build('<@1> https://a.com <@1> https://a.com').content).toBe('<@1> https://a.com');
	});

	it("doesn't take @here or @everyone out of a word, such as an email address", () => {
		expect(build('mail bob@heretic.org or team@everyoneinc.com').content).toBeUndefined();
	});

	it("doesn't repeat escaped mentions, which don't ping", () => {
		expect(build('\\@everyone and \\<@123> are literal').content).toBeUndefined();
	});

	it("doesn't repeat mentions or links in code or spoilers", () => {
		expect(
			build('`@everyone` and ```\n<@1> https://a.com\n``` and ||https://spoiler.com @here||').content,
		).toBeUndefined();
	});

	it('separates back-to-back markdown links', () => {
		expect(build('[a](https://a.com)[b](https://b.com)').content).toBe('https://a.com https://b.com');
	});

	it('keeps balanced parentheses in a link', () => {
		expect(build('see https://en.wikipedia.org/wiki/Foo_(bar).').content).toBe(
			'https://en.wikipedia.org/wiki/Foo_(bar)',
		);
	});

	it('stops a link at markdown emphasis', () => {
		expect(build('*https://a.com*').content).toBe('https://a.com');
	});

	it('keeps the content within 2000 characters', () => {
		// 2000 characters of mentions with no spaces: joined with spaces, they'd be longer.
		const text = Array.from({ length: 200 }, (_, i) => `<@${1_000_000 + i}>`).join('');
		const { content } = build(text);

		expect(text.length).toBe(2000);
		expect(content!.length).toBeLessThanOrEqual(2000);
		expect(content).toMatch(/^<@1000000> <@1000001> /);
	});

	it('leaves mentions out when asked (DMs), but still repeats links', () => {
		const message = buildReminderMessage('Reminder', '@everyone <@1> https://a.com', 60, { mentions: false });

		expect(message.content).toBe('https://a.com');
	});

	it('sends an embed without a description for whitespace-only text', () => {
		const { content, embed } = build('   ');

		expect(content).toBeUndefined();
		expect(embed.description).toBeUndefined();
		expect(embed.title).toBe('water');
	});
});
