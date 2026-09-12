import { describe, it, expect } from 'vitest';
import userCommand from '../../../src/commands/utility/user.ts';
import { createMockInteraction } from '../../mockInteraction.ts';

describe('/user', () => {
    it('rejects when not run in a cached guild', async () => {
        const interaction = createMockInteraction({ inCachedGuild: false });
        await userCommand.execute(interaction as never);
        expect(interaction.reply).toHaveBeenCalledWith('This command can only be used in a server.');
    });

	it('replies with the username and join date', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			user: { id: 'u1', username: 'testuser' },
			member: { joinedAt: new Date('2024-01-01') },
		});
		await userCommand.execute(interaction as never);
		expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('testuser'));
	});
});