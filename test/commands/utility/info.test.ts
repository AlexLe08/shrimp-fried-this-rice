import { describe, it, expect, vi } from 'vitest';
import infoCommand from '../../../src/commands/utility/info.ts';
import { createMockInteraction } from '../../mockInteraction.ts';

describe('/info user', () => {
	it('falls back to basic info when not in a cached guild', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: false,
			options: { subcommand: 'user' },
			user: { id: 'u1', username: 'invoker' },
		});
		await infoCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('invoker') }),
		);
	});

	it('defaults to the invoking user when no target is given', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: false,
			options: { subcommand: 'user', users: { target: null } },
			user: { id: 'u1', username: 'invoker' },
		});
		await infoCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('invoker') }),
		);
	});

	it('shows full member info when the target is found via fetch', async () => {
		const targetUser = { id: 'u2', username: 'targetuser' };
		const member = {
			id: 'u2',
			user: { username: 'targetuser', createdAt: new Date('2020-01-01') },
			joinedAt: new Date('2024-01-01'),
		};
        // we mock the fetch method to return the member object when called with the target user's ID
        // this simulates the behavior of fetching a member from the guild's member cache
		const membersFetch = vi.fn().mockResolvedValue(member);

		const interaction = createMockInteraction({
			inCachedGuild: true,
			options: { subcommand: 'user', users: { target: targetUser } },
			guild: { id: 'g1', members: { fetch: membersFetch } },
		});
		await infoCommand.execute(interaction as never);

		expect(membersFetch).toHaveBeenCalledWith('u2');
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('targetuser') }),
		);
	});

	it('falls back gracefully when the target is not a member of the server', async () => {
		const targetUser = { id: 'u3', username: 'nonmember' };
        // we mock the fetch method to reject with an error when called with the target user's ID
        // this simulates the behavior of trying to fetch a member that does not exist in the guild's member cache
		const membersFetch = vi.fn().mockRejectedValue(new Error('Unknown Member'));

		const interaction = createMockInteraction({
			inCachedGuild: true,
			options: { subcommand: 'user', users: { target: targetUser } },
            // We provide a guild object with a mocked members.fetch method that simulates the behavior of fetching a member
            // The real command casts its parameter with as never in the test, and discord.js's own types are bypassed the same way, so we can safely mock the guild and members.fetch method here without worrying about type errors
			guild: { id: 'g1', members: { fetch: membersFetch } },
		});
		await infoCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('not currently a member') }),
		);
	});
});

describe('/info server', () => {
	it('rejects when not run in a cached guild', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: false,
			options: { subcommand: 'server' },
		});
		await infoCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('only be used in a server') }),
		);
	});

	it('replies with server name and member count', async () => {
		const interaction = createMockInteraction({
			inCachedGuild: true,
			options: { subcommand: 'server' },
			guild: { id: 'g1', name: 'Test Server', memberCount: 99, createdAt: new Date('2019-01-01') },
		});
		await infoCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('Test Server') }),
		);
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('99') }),
		);
	});
});