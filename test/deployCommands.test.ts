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

	it('exits nonzero when Discord refuses the registration', async () => {
		const error = new Error('401: Unauthorized');
		put.mockRejectedValue(error);

		await runDeployCommands();

		expect(console.error).toHaveBeenCalledWith(error);
		expect(process.exitCode).toBe(1);
	});
});
