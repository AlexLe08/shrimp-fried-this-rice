import { describe, it, expect } from 'vitest';
import serverCommand from '../../../src/commands/utility/server.ts';
import { createMockInteraction } from '../../mockInteraction.ts';

describe('/server', () => {
    it('rejects when not run in a cached guild', async () => {
        const interaction = createMockInteraction({ inCachedGuild: false });
        await serverCommand.execute(interaction as never);
        expect(interaction.reply).toHaveBeenCalledWith('This command can only be used in a server.');
    });

	it('replies with the server name and member count', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			guild: { id: 'g1', name: 'Test Server', memberCount: 42 },
		});
		await serverCommand.execute(interaction as never);
		expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('Test Server'));
		expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('42'));
	});
});