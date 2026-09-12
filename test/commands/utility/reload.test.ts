import { describe, it, expect, vi } from 'vitest';
import reloadCommand from '../../../src/commands/utility/reload.ts';
import { createMockInteraction } from '../../mockInteraction.ts';
import { Collection } from 'discord.js';

describe('/reload', () => {
	it('rejects an unknown command name', async () => {
		const interaction = createMockInteraction({
			options: { strings: { command: 'doesnotexist' } },
			client: { commands: new Collection<string, unknown>(), cooldowns: new Collection<string, unknown>() },
		});
		await reloadCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('no command with name') }),
		);
	});

	it('reports when the command file cannot be located on disk', async () => {
		// Registered in the commands collection, but with no matching file anywhere under commands/
        // This simulates the scenario where a command is registered but its source file has been deleted or moved
		const commands = new Collection<string, unknown>([['ghostcommand', { data: { name: 'ghostcommand' }, execute: vi.fn() }]]);
		const interaction = createMockInteraction({
			options: { strings: { command: 'ghostcommand' } },
			client: { commands, cooldowns: new Collection<string, unknown>() },
		});
		await reloadCommand.execute(interaction as never);

		expect(interaction.reply).toHaveBeenCalledWith(
		    expect.objectContaining({ content: expect.stringContaining('Could not find a command file') }),
	);
	});

	it('reloads a real, existing command file and updates the commands collection', async () => {
        // We simulate a command that exists in the commands collection and has a corresponding file on disk
		const commands = new Collection<string, unknown>([['ping', { data: { name: 'ping' }, execute: vi.fn() }]]);
		const interaction = createMockInteraction({
			options: { strings: { command: 'ping' } },
			client: { commands, cooldowns: new Collection<string, unknown>() },
		});
		await reloadCommand.execute(interaction as never);

		const reloaded = commands.get('ping') as { data: { name: string } } | undefined;
		expect(reloaded?.data.name).toBe('ping');
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('was reloaded') }),
		);
	});
});