import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Command } from './types/command.ts';

const srcDir = path.join(import.meta.dirname, '..');

// Every .ts file in src/<area>/<folder>/, so an area's commands and events
// load without being listed anywhere. Sorted, as readdir's order depends on
// the filesystem. Returned as file URLs: import() of a bare path fails on
// Windows.
export function findAreaModules(folder: 'commands' | 'events'): string[] {
	return fs
		.readdirSync(srcDir, { withFileTypes: true })
		.filter((area) => area.isDirectory() && fs.existsSync(path.join(srcDir, area.name, folder)))
		.flatMap((area) => {
			const folderPath = path.join(srcDir, area.name, folder);
			return fs
				.readdirSync(folderPath)
				.filter((file) => file.endsWith('.ts'))
				.map((file) => path.join(folderPath, file));
		})
		.sort()
		.map((filePath) => pathToFileURL(filePath).href);
}

// The one command list: index.ts serves it and deploy-commands.ts registers
// it, so the two can't drift apart.
export async function loadCommands(): Promise<Command[]> {
	const commands: Command[] = [];
	for (const fileUrl of findAreaModules('commands')) {
		const commandModule = (await import(fileUrl)) as { default: Command };
		const command = commandModule.default;
		if (command && 'data' in command && 'execute' in command) {
			commands.push(command);
		} else {
			console.log(
				`[WARNING] The command at ${fileURLToPath(fileUrl)} is missing a required "data" or "execute" property.`,
			);
		}
	}
	return commands;
}
