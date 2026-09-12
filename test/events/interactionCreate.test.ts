import { describe, it, expect, vi } from 'vitest';
import { Collection } from 'discord.js';
import interactionCreateEvent from '../../src/events/interactionCreate.ts';
import { createMockInteraction } from '../mockInteraction.ts';

describe('interactionCreate event', () => {
	it('ignores interactions that are not chat input commands', async () => {
		const interaction = createMockInteraction({ isChatInputCommand: false });
		await interactionCreateEvent.execute(interaction as never);
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it('logs an error and does nothing when the command is not found', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const interaction = createMockInteraction({
			isChatInputCommand: true,
			commandName: 'doesnotexist',
			client: { commands: new Collection(), cooldowns: new Collection() },
		});
		await interactionCreateEvent.execute(interaction as never);

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No command matching'));
		expect(interaction.reply).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('executes the command when not on cooldown', async () => {
		const execute = vi.fn().mockResolvedValue(undefined);
		const commands = new Collection<string, unknown>();
		commands.set('ping', { data: { name: 'ping' }, execute });

		const interaction = createMockInteraction({
			isChatInputCommand: true,
			commandName: 'ping',
			user: { id: 'u1', username: 'tester' },
			client: { commands, cooldowns: new Collection() },
		});
		await interactionCreateEvent.execute(interaction as never);

		expect(execute).toHaveBeenCalledWith(interaction);
	});

	it('blocks execution and replies with a cooldown message when still on cooldown', async () => {
		const execute = vi.fn().mockResolvedValue(undefined);
		const commands = new Collection<string, unknown>();
		commands.set('ping', { data: { name: 'ping' }, cooldown: 60, execute });

		const timestamps = new Collection<string, number>();
		timestamps.set('u1', Date.now());
		const cooldowns = new Collection<string, unknown>();
		cooldowns.set('ping', timestamps);

		const interaction = createMockInteraction({
			isChatInputCommand: true,
			commandName: 'ping',
			user: { id: 'u1', username: 'tester' },
			client: { commands, cooldowns },
		});
		await interactionCreateEvent.execute(interaction as never);

		expect(execute).not.toHaveBeenCalled();
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('cooldown') }),
		);
	});

	it('replies with a generic error message if the command throws', async () => {
		const execute = vi.fn().mockRejectedValue(new Error('boom'));
		const commands = new Collection<string, unknown>();
		commands.set('ping', { data: { name: 'ping' }, execute });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const interaction = createMockInteraction({
			isChatInputCommand: true,
			commandName: 'ping',
			user: { id: 'u1', username: 'tester' },
			client: { commands, cooldowns: new Collection() },
		});
		await interactionCreateEvent.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('error') }),
		);
		consoleSpy.mockRestore();
	});

	it('uses followUp instead of reply when the interaction was already deferred', async () => {
		const execute = vi.fn().mockRejectedValue(new Error('boom'));
		const commands = new Collection<string, unknown>();
		commands.set('ping', { data: { name: 'ping' }, execute });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const interaction = createMockInteraction({
			isChatInputCommand: true,
			commandName: 'ping',
			user: { id: 'u1', username: 'tester' },
			client: { commands, cooldowns: new Collection() },
			deferred: true,
		});
		await interactionCreateEvent.execute(interaction as never);

		expect(interaction.followUp).toHaveBeenCalled();
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it('does not crash even if the fallback error reply itself fails', async () => {
		const execute = vi.fn().mockRejectedValue(new Error('boom'));
		const commands = new Collection<string, unknown>();
		commands.set('ping', { data: { name: 'ping' }, execute });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const interaction = createMockInteraction({
			isChatInputCommand: true,
			commandName: 'ping',
			user: { id: 'u1', username: 'tester' },
			client: { commands, cooldowns: new Collection() },
		});
		interaction.reply.mockRejectedValueOnce(new Error('already acknowledged'));

		await expect(interactionCreateEvent.execute(interaction as never)).resolves.not.toThrow();
		expect(consoleSpy).toHaveBeenCalledTimes(2); // the original command error, plus the fallback failure
		consoleSpy.mockRestore();
	});
});