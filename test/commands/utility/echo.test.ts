import { describe, it, expect, vi } from 'vitest';
import echoCommand from '../../../src/commands/utility/echo.ts';
import { createMockInteraction } from '../../mockInteraction.ts';

describe('/echo', () => {
	it('rejects when not run in a cached guild', async () => {
		const interaction = createMockInteraction({ inCachedGuild: false });
        // as never is used here to bypass type checking for the mock interaction, since the command expects a specific interaction type
		await echoCommand.execute(interaction as never);
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('only be used in a server') }),
		);
	});

	it('rejects a non-text-based channel', async () => {
		const channel = { isTextBased: () => false };
		const interaction = createMockInteraction({
			inCachedGuild: true,
			options: { strings: { input: 'hello' }, channels: { channel } },
		});
        // we're passing the mock as a function argument to the command, so we need to cast it to `never` to satisfy the type checker
        await echoCommand.execute(interaction as never);
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('text channel') }),
		);
	});

	it('sends the message to the chosen channel and confirms', async () => {
		const send = vi.fn().mockResolvedValue(undefined);
		const channel = { isTextBased: () => true, send, toString: () => '#general' };
		const interaction = createMockInteraction({
			inCachedGuild: true,
			options: { strings: { input: 'hello world' }, channels: { channel } },
		});
		await echoCommand.execute(interaction as never);
		expect(send).toHaveBeenCalledWith('hello world');
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Echoed') }));
	});
});