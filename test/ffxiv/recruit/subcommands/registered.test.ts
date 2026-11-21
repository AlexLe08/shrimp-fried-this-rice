import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import recruitCommand from '../../../../src/ffxiv/commands/recruit.ts';

// /recruit registers its subcommands from a hand-written list, so a new file
// left out of it would never reach Discord (as for /reminder's).
describe('/recruit subcommands', () => {
	const folder = path.resolve(import.meta.dirname, '../../../../src/ffxiv/recruit/subcommands');
	const files = readdirSync(folder).filter((file) => file.endsWith('.ts') && file !== 'helpers.ts');

	it('registers every handler in src/ffxiv/recruit/subcommands', async () => {
		const registered = (recruitCommand.data.toJSON().options ?? []).map((option) => option.name);
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
