import { describe, it, expect } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import { buildReminderMessage, reminderContent } from '../../src/reminders/reminderMessage.ts';

function build(text: string) {
	const message = buildReminderMessage('water', text, 60);
	return { content: message.content, embed: (message.embeds?.[0] as EmbedBuilder | undefined)?.toJSON() };
}

describe('buildReminderMessage', () => {
	it('puts the text in an embed titled with the label, with the interval in the footer', () => {
		const { content, embed } = build('Drink water!');

		expect(content).toBeUndefined();
		expect(embed?.title).toBe('water');
		expect(embed?.description).toBe('Drink water!');
		expect(embed?.footer?.text).toBe('Every 60 minutes');
		expect(embed?.color).toBeTypeOf('number');
	});

	it('repeats user, role, @everyone and @here mentions outside the embed so they ping', () => {
		const { content, embed } = build('<@123> <@!456> <@&789> @everyone @here time to raid');

		expect(content).toBe('<@123> <@!456> <@&789> @everyone @here');
		expect(embed?.description).toBe('<@123> <@!456> <@&789> @everyone @here time to raid');
	});

	it("leaves channel mentions in the embed only, since they don't ping", () => {
		expect(build('see <#123>').content).toBeUndefined();
	});

	it('lists a repeated mention once', () => {
		expect(build('<@1> and <@1> again').content).toBe('<@1>');
	});

	it("doesn't take @here or @everyone out of a word, such as an email address", () => {
		expect(build('mail bob@heretic.org or team@everyoneinc.com').content).toBeUndefined();
	});

	it("doesn't repeat escaped mentions, which don't ping", () => {
		expect(build('\\@everyone and \\<@123> are literal').content).toBeUndefined();
	});

	it("doesn't repeat mentions in code or spoilers", () => {
		expect(build('`@everyone` and ```\n<@1>\n``` and ||@here||').content).toBeUndefined();
	});

	it('keeps the content within 2000 characters', () => {
		// 2000 characters of mentions with no spaces: joined with spaces, they'd be longer.
		const text = Array.from({ length: 200 }, (_, i) => `<@${1_000_000 + i}>`).join('');
		const { content } = build(text);

		expect(text.length).toBe(2000);
		expect(content!.length).toBeLessThanOrEqual(2000);
		expect(content).toMatch(/^<@1000000> <@1000001> /);
	});

	it('leaves mentions out when asked (DMs)', () => {
		const message = buildReminderMessage('Reminder', '@everyone <@1> stretch', 60, { mentions: false });

		expect(message.content).toBeUndefined();
		expect(message.embeds).toHaveLength(1);
	});

	it('sends an embed without a description for whitespace-only text', () => {
		const { content, embed } = build('   ');

		expect(content).toBeUndefined();
		expect(embed?.description).toBeUndefined();
		expect(embed?.title).toBe('water');
	});

	describe('a message with a link', () => {
		it('is sent as plain text, unchanged, so the link still previews', () => {
			const text = '<@1> raid time https://www.youtube.com/watch?v=abc';

			expect(buildReminderMessage('water', text, 60)).toEqual({ content: text });
		});

		it('is plain text in DMs too', () => {
			expect(buildReminderMessage('Reminder', 'https://a.com', 60, { mentions: false })).toEqual({
				content: 'https://a.com',
			});
		});

		it('stays an embed when the link asked for no preview, or is in code or a spoiler', () => {
			for (const text of ['quiet <https://a.com>', '`https://a.com`', '```\nhttps://a.com\n```', '||https://a.com||']) {
				expect(build(text).embed?.description).toBe(text);
			}
		});
	});
});

describe('reminderContent', () => {
	it("is buildReminderMessage's embed when embed is set", () => {
		expect(reminderContent('water', '<@1> drink', 60, { embed: true })).toEqual(
			buildReminderMessage('water', '<@1> drink', 60),
		);
	});

	it('passes mentions: false on, for DMs', () => {
		expect(reminderContent('Reminder', '<@1> drink', 60, { embed: true, mentions: false })).toEqual(
			buildReminderMessage('Reminder', '<@1> drink', 60, { mentions: false }),
		);
	});

	it('is the text as typed when embed is off', () => {
		expect(reminderContent('water', '<@1> drink', 60, { embed: false })).toBe('<@1> drink');
	});
});
