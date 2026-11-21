import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import reminderCommand from '../../../src/reminders/commands/reminder.ts';

// /reminder registers its subcommands from a hand-written list, so a new file
// left out of it would never reach Discord; the command snapshot can't catch
// that, as nothing it records changes.
describe('/reminder subcommands', () => {
	const folder = path.resolve(import.meta.dirname, '../../../src/reminders/subcommands');
	const files = readdirSync(folder).filter((file) => file.endsWith('.ts') && file !== 'helpers.ts');

	it('registers every handler in src/reminders/subcommands', async () => {
		const registered = (reminderCommand.data.toJSON().options ?? []).map((option) => option.name);
		const names = await Promise.all(
			files.map(async (file) => {
				const module = (await import(pathToFileURL(path.join(folder, file)).href)) as { default: { name: string } };
				return module.default.name;
			}),
		);

		expect(names.length).toBeGreaterThan(0);
		expect([...registered].sort()).toEqual([...names].sort());
	});
});
