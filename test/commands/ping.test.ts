import { describe, it, expect } from 'vitest';
import pingCommand from '../../src/commands/utility/ping.ts';
import { createMockInteraction } from '../mockInteraction.ts';

describe('/ping', () => {
	it('replies with Pong!', async () => {
		const interaction = createMockInteraction();
        // as never is used here to bypass type checking for the mock interaction, since the command expects a specific interaction type
		await pingCommand.execute(interaction as never);
		expect(interaction.reply).toHaveBeenCalledWith('Pong!');
	});
});