import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AVATARS } from '../../../src/minecraft/bridge/avatars.ts';
import { DEFAULT_IGNORE } from '../../../src/minecraft/bridge/classify.ts';
import { ConfigError, loadConfig, parseConfig } from '../../../src/minecraft/bridge/config.ts';

const CHAT = 'https://discord.com/api/webhooks/123/chat-token';
const ALERTS = 'https://discord.com/api/webhooks/456/alerts_token';
const valid = () => ({
	serverName: 'Survival',
	logPath: '/srv/logs/latest.log',
	webhooks: { chat: CHAT, alerts: ALERTS },
});

function problems(raw: unknown): string[] {
	try {
		parseConfig(raw);
	} catch (error) {
		if (error instanceof ConfigError) return error.problems;
		throw error;
	}
	return [];
}

describe('parseConfig', () => {
	it('accepts a minimal config, with the built-in ignore list', () => {
		expect(parseConfig(valid())).toEqual({
			serverName: 'Survival',
			logPath: '/srv/logs/latest.log',
			webhooks: { chat: CHAT, alerts: ALERTS },
			ignore: [...DEFAULT_IGNORE],
			avatars: DEFAULT_AVATARS,
		});
	});

	it('adds ignorePatterns to the built-in list, without the stateful g flag', () => {
		const { ignore } = parseConfig({
			...valid(),
			ignorePatterns: ['Ambiguity between', 'lost connection: Disconnected'],
		});
		expect(ignore).toHaveLength(DEFAULT_IGNORE.length + 2);
		const added = ignore.at(-1)!;
		expect(added.flags).toBe('');
		expect(added.test('Steve lost connection: Disconnected')).toBe(true);
		expect(added.test('Steve lost connection: Disconnected')).toBe(true);
	});

	it('accepts format "vanilla" and the other Discord webhook hosts', () => {
		expect(
			problems({
				...valid(),
				format: 'vanilla',
				webhooks: {
					chat: 'https://canary.discord.com/api/v10/webhooks/1/abc',
					alerts: 'https://discordapp.com/api/webhooks/2/def',
				},
			}),
		).toEqual([]);
	});

	it('reports every problem at once', () => {
		expect(
			problems({ serverName: '', webhooks: { chat: 'https://example.com/hook' }, format: 'paper', extra: 1 }),
		).toEqual([
			'unknown key "extra"',
			'"serverName" must be a name of 1 to 80 characters',
			'"logPath" must be the path to the server\'s logs/latest.log',
			'"format" can only be "vanilla" for now',
			'"webhooks.chat" must be a Discord webhook URL (https://discord.com/api/webhooks/…)',
			'"webhooks.alerts" must be a Discord webhook URL (https://discord.com/api/webhooks/…)',
		]);
	});

	it('refuses a server name Discord would refuse as a sender', () => {
		expect(problems({ ...valid(), serverName: 'My Discord SMP' })).toEqual([
			'"serverName" can\'t contain "clyde" or "discord"',
		]);
		expect(problems({ ...valid(), serverName: 'x'.repeat(81) })).toHaveLength(1);
	});

	it('refuses misspelt keys', () => {
		expect(problems({ ...valid(), avatar: {}, crashReportDir: '/srv/crash-reports' })).toEqual([
			'unknown key "avatar"',
			'unknown key "crashReportDir"',
		]);
		expect(problems({ ...valid(), webhooks: { chat: CHAT, alerts: ALERTS, alert: ALERTS } })).toEqual([
			'unknown key "webhooks.alert"',
		]);
	});

	it('accepts avatars, reporting its problems with the rest', () => {
		const { avatars } = parseConfig({ ...valid(), avatars: { default: 'none', players: { Steve: 'skin' } } });
		expect(avatars.default).toEqual({ kind: 'none' });
		expect(avatars.players.get('steve')).toEqual({ kind: 'skin' });
		expect(problems({ ...valid(), serverName: '', avatars: { default: 'everyone' } })).toEqual([
			'"serverName" must be a name of 1 to 80 characters',
			'"avatars.default" must be "skin", "generated" or "none"',
		]);
	});

	it('accepts crashReportsDir, and refuses one that is not a path', () => {
		expect(parseConfig({ ...valid(), crashReportsDir: '/srv/crash-reports' }).crashReportsDir).toBe(
			'/srv/crash-reports',
		);
		expect(parseConfig(valid())).not.toHaveProperty('crashReportsDir');
		for (const crashReportsDir of ['', ' ', 3]) {
			expect(problems({ ...valid(), crashReportsDir })).toEqual([
				'"crashReportsDir" must be the path to the server\'s crash-reports folder',
			]);
		}
	});

	it('refuses a channel link or an http URL in place of a webhook', () => {
		expect(
			problems({
				...valid(),
				webhooks: { chat: 'https://discord.com/channels/1/2', alerts: 'http://discord.com/api/webhooks/1/abc' },
			}),
		).toHaveLength(2);
	});

	it('reports a bad ignore pattern by its index', () => {
		const found = problems({ ...valid(), ignorePatterns: ['ok', '(unclosed', 3] });
		expect(found).toHaveLength(2);
		expect(found[0]).toMatch(/^"ignorePatterns\[1\]" isn't a valid regular expression/);
		expect(found[1]).toBe('"ignorePatterns[2]" must be a string');
	});

	it('refuses something other than an object', () => {
		expect(problems([])).toEqual(['the config must be a JSON object']);
		expect(problems({ ...valid(), webhooks: [CHAT] })).toEqual([
			'"webhooks" must be an object with "chat" and "alerts" webhook URLs',
		]);
	});
});

describe('loadConfig', () => {
	it('loads the committed example', async () => {
		const config = await loadConfig(join(import.meta.dirname, '../../../mcbridge.example.json'));
		expect(config.serverName).toBe('Survival');
	});

	it('says which file is missing or not JSON, giving the place but none of the text', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'mcbridge-config-'));
		try {
			const path = join(dir, 'mcbridge.json');
			await expect(loadConfig(path)).rejects.toThrow(`can't read ${path}`);
			await writeFile(
				path,
				'{\n  "webhooks": { "chat": "https://discord.com/api/webhooks/1/secret-token" }\n  "x": 1\n}',
			);
			const error = (await loadConfig(path).catch((caught: unknown) => caught)) as ConfigError;
			expect(error.problems).toEqual([`${path} isn't valid JSON (line 3, column 3)`]);
			expect(error.message).not.toContain('secret');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("accepts a file starting with a byte order mark, and reads logPath from the config file's folder", async () => {
		const dir = await mkdtemp(join(tmpdir(), 'mcbridge-config-'));
		try {
			const path = join(dir, 'mcbridge.json');
			await writeFile(path, `\uFEFF${JSON.stringify({ ...valid(), logPath: 'server/logs/latest.log' })}`);
			const config = await loadConfig(path);
			expect(config.logPath).toBe(join(dir, 'server/logs/latest.log'));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads a relative crashReportsDir from the config file's folder", async () => {
		const dir = await mkdtemp(join(tmpdir(), 'mcbridge-config-'));
		try {
			const path = join(dir, 'mcbridge.json');
			await writeFile(path, JSON.stringify({ ...valid(), crashReportsDir: 'server/crash-reports' }));
			expect((await loadConfig(path)).crashReportsDir).toBe(join(dir, 'server/crash-reports'));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('keeps an absolute logPath as it is', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'mcbridge-config-'));
		try {
			const path = join(dir, 'mcbridge.json');
			await writeFile(path, JSON.stringify(valid()));
			expect((await loadConfig(path)).logPath).toBe(resolve('/srv/logs/latest.log'));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
