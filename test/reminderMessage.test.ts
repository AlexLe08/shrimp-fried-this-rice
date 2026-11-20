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
});
