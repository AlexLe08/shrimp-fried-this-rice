import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { put } = vi.hoisted(() => ({ put: vi.fn() }));

// Keeps the real .env (the local-dev token) out of the test.
vi.mock('dotenv/config', () => ({}));

vi.mock('discord.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('discord.js')>();
	return {
		...actual,
		REST: class {
			setToken() {
				return this;
			}
			put = put;
		},
	};
});

async function runDeployCommands(): Promise<void> {
	vi.resetModules();
	await import('../src/deploy-commands.ts');
}

describe('deploy-commands', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv('DISCORD_TOKEN', 'test-token');
		vi.stubEnv('DISCORD_CLIENT_ID', 'test-client-id');
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it('registers every command and leaves the exit code at 0', async () => {
		put.mockResolvedValue([{}, {}]);

		await runDeployCommands();

		expect(put).toHaveBeenCalledWith(
			expect.stringContaining('test-client-id'),
			expect.objectContaining({ body: expect.any(Array) }),
		);
		expect(console.log).toHaveBeenCalledWith('Successfully reloaded 2 application (/) commands.');
		expect(process.exitCode).toBeUndefined();
	});

	// What users see in Discord: names, options, descriptions, choices and
	// permissions. A refactor that changes any of them fails here; one that
	// means to updates the snapshot (`npx vitest -u`) in the same PR.
	it('registers the same command definitions', async () => {
		put.mockResolvedValue([]);

		await runDeployCommands();

		const { body } = put.mock.calls[0]![1] as { body: { name: string }[] };
		// Through JSON, as REST sends it: a key left undefined never reaches
		// Discord, so a builder that omits it instead isn't a change.
		const sent = JSON.parse(JSON.stringify(body)) as { name: string }[];
		// Sorted so the order the loader reads files in can't change the snapshot.
		const definitions = sent.sort((a, b) => a.name.localeCompare(b.name));
		expect(definitions.map((command) => command.name)).toEqual(['reminder', 'remindme']);
		expect(definitions).toMatchSnapshot();
	});

	it('exits nonzero when Discord refuses the registration', async () => {
		const error = new Error('401: Unauthorized');
		put.mockRejectedValue(error);

		await runDeployCommands();

		expect(console.error).toHaveBeenCalledWith(error);
		expect(process.exitCode).toBe(1);
	});
});
