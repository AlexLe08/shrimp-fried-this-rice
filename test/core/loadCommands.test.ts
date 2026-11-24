import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findAreaModules, loadCommands } from '../../src/core/loadCommands.ts';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function relativeToSrc(fileUrls: string[]): string[] {
	return fileUrls.map((fileUrl) => path.relative(srcDir, fileURLToPath(fileUrl)).split(path.sep).join('/'));
}

describe('findAreaModules', () => {
	// index.ts has no test of its own, so this is what pins the events it listens to.
	it('finds every event module in an area events folder', () => {
		expect(relativeToSrc(findAreaModules('events'))).toEqual([
			'core/events/interactionCreate.ts',
			'core/events/ready.ts',
			'minecraft/events/guildDelete.ts',
		]);
	});

	it('finds every command module in an area commands folder', () => {
		expect(relativeToSrc(findAreaModules('commands'))).toEqual([
			'ffxiv/commands/recruit.ts',
			'reminders/commands/reminder.ts',
			'reminders/commands/remindme.ts',
		]);
	});
});

describe('loadCommands', () => {
	it('loads each command module', async () => {
		const commands = await loadCommands();

		expect(commands.map((command) => command.data.name)).toEqual(['recruit', 'reminder', 'remindme']);
	});
});
