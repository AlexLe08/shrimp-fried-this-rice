import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlertGate, DEFAULT_ALERT_GATE } from '../../../src/minecraft/bridge/alertGate.ts';
import { DEFAULT_AVATARS, hashName } from '../../../src/minecraft/bridge/avatars.ts';
import { createBridge } from '../../../src/minecraft/bridge/bridge.ts';
import { DEFAULT_IGNORE } from '../../../src/minecraft/bridge/classify.ts';
import type { BridgeConfig } from '../../../src/minecraft/bridge/config.ts';
import type { Post } from '../../../src/minecraft/bridge/sender.ts';

const CHAT = 'https://discord.com/api/webhooks/1/chat';
const ALERTS = 'https://discord.com/api/webhooks/2/alerts';
const config: BridgeConfig = {
	serverName: 'Survival',
	logPath: '/srv/logs/latest.log',
	webhooks: { chat: CHAT, alerts: ALERTS },
	ignore: [...DEFAULT_IGNORE],
	avatars: DEFAULT_AVATARS,
};
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

function setup(options: Partial<Parameters<typeof createBridge>[0]> = {}) {
	const posts: Post[] = [];
	const log = vi.fn<(message: string) => void>();
	const bridge = createBridge({ config, sender: { send: (post) => posts.push(post) }, log, ...options });
	return { bridge, posts, log };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createBridge', () => {
	it('posts chat under the player, and joins and start to the chat webhook', () => {
		const { bridge, posts } = setup();
		bridge.onLines([
			'[12:00:00] [Server thread/INFO]: Done (8.123s)! For help, type "help"',
			'[12:00:05] [Server thread/INFO]: System chat: Steve joined the game',
			'[12:00:06] [Server thread/INFO]: <Steve> hi',
			'[12:00:07] [Server thread/INFO]: Stopping server',
		]);
		vi.advanceTimersByTime(1000);
		expect(posts.map(({ webhook, username, content, droppable }) => [webhook, username, content, droppable])).toEqual([
			[CHAT, 'Survival', '🟢 **Survival** is up (started in 8.123 s)', false],
			[CHAT, 'Survival', '➕ **Steve** joined', true],
			[CHAT, 'Steve', 'hi', true],
			[CHAT, 'Survival', '🔴 **Survival** is stopping', false],
		]);
	});

	it("posts a real log's start, joins and chat, and none of its routine lines", () => {
		const { bridge, posts } = setup();
		bridge.onLines(fixture('vanilla-26.3-startup.log').split('\n'));
		vi.advanceTimersByTime(1000);
		expect(posts.map(({ content }) => content)).toEqual([
			'🟢 **Survival** is up (started in 0.35 s)',
			'➕ **Steve** joined',
			'hello i am here',
			'what is that',
			'➖ **Steve** left',
		]);
	});

	describe('avatars', () => {
		const ONLINE = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
		const skins = { ...config, avatars: { default: { kind: 'skin' as const }, players: new Map() } };
		const avatars = (posts: Post[]) => posts.map(({ username, avatarUrl }) => [username, avatarUrl]);

		it('gives chat a generated picture by default, and server posts none', () => {
			const { bridge, posts } = setup();
			bridge.onLines(fixture('vanilla-26.3-startup.log').split('\n'));
			vi.advanceTimersByTime(1000);
			const steve = `https://raw.githubusercontent.com/AlexLe08/shrimp-fried-this-rice/main/assets/mcbridge-avatars/${hashName('Steve')}.png`;
			expect(avatars(posts)).toEqual([
				['Survival', undefined],
				['Survival', undefined],
				['Steve', steve],
				['Steve', steve],
				['Survival', undefined],
			]);
		});

		it('looks a skin up by the UUID logged at login, or by name when the login was not seen', () => {
			const { bridge, posts } = setup({ config: skins });
			bridge.onLines([
				`[12:00:00] [User Authenticator #1/INFO]: UUID of player Notch is ${ONLINE}`,
				'[12:00:01] [Server thread/INFO]: Notch joined the game',
				'[12:00:02] [Server thread/INFO]: <Notch> hi',
				'[12:00:03] [Server thread/INFO]: <jeb_> logged in before the log rotated',
			]);
			vi.advanceTimersByTime(1000);
			expect(avatars(posts.filter(({ username }) => username !== 'Survival'))).toEqual([
				['Notch', 'https://mc-heads.net/avatar/069a79f444e94726a5befca90e38aaf5/128'],
				['jeb_', 'https://mc-heads.net/avatar/jeb_/128'],
			]);
		});

		it('keeps the UUID of a player who logs in again while online, whose old session leaves after', () => {
			const { bridge, posts } = setup({ config: skins });
			bridge.onLines([
				`[12:00:00] [User Authenticator #1/INFO]: UUID of player Notch is ${ONLINE}`,
				'[12:00:01] [Server thread/INFO]: Notch joined the game',
				`[12:01:00] [User Authenticator #2/INFO]: UUID of player Notch is ${ONLINE}`,
				'[12:01:00] [Server thread/INFO]: Notch left the game',
				'[12:01:00] [Server thread/INFO]: Notch joined the game',
				'[12:01:01] [Server thread/INFO]: <Notch> back',
			]);
			vi.advanceTimersByTime(1000);
			expect(posts.find(({ username }) => username === 'Notch')?.avatarUrl).toBe(
				'https://mc-heads.net/avatar/069a79f444e94726a5befca90e38aaf5/128',
			);
		});

		it('looks no name up once an offline-mode UUID was seen, until the server restarts', () => {
			const { bridge, posts } = setup({ config: skins });
			bridge.onLines([
				'[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is 5627dd98-e6be-3c21-b8a8-e92344183641',
				'[12:00:01] [Server thread/INFO]: <Notch> no login line seen for me',
				'[12:00:02] [Server thread/INFO]: Stopping server',
				'[12:01:00] [Server thread/INFO]: Done (1.0s)! For help, type "help"',
				'[12:01:01] [Server thread/INFO]: <Notch> and after a restart',
			]);
			vi.advanceTimersByTime(1000);
			expect(posts.filter(({ username }) => username === 'Notch').map(({ avatarUrl }) => avatarUrl)).toEqual([
				`https://raw.githubusercontent.com/AlexLe08/shrimp-fried-this-rice/main/assets/mcbridge-avatars/${hashName('Notch')}.png`,
				'https://mc-heads.net/avatar/Notch/128',
			]);
		});

		it('keeps the UUIDs of players online when the helper starts, unless the server stopped since', () => {
			const stopped = setup({ config: skins });
			stopped.bridge.onBacklog(
				[
					`[11:00:00] [User Authenticator #1/INFO]: UUID of player Notch is ${ONLINE}`,
					'[11:00:01] [Server thread/INFO]: Notch joined the game',
					'[11:00:03] [Server thread/INFO]: Stopping server',
				].join('\n'),
			);
			stopped.bridge.onLines(['[12:00:00] [Server thread/INFO]: <Notch> hi']);
			vi.advanceTimersByTime(1000);
			expect(avatars(stopped.posts)).toEqual([['Notch', 'https://mc-heads.net/avatar/Notch/128']]);

			const online = setup({ config: skins });
			online.bridge.onBacklog(`[11:00:00] [User Authenticator #1/INFO]: UUID of player Notch is ${ONLINE}`);
			online.bridge.onLines(['[12:00:00] [Server thread/INFO]: <Notch> hi']);
			vi.advanceTimersByTime(1000);
			expect(avatars(online.posts)).toEqual([
				['Notch', 'https://mc-heads.net/avatar/069a79f444e94726a5befca90e38aaf5/128'],
			]);
		});

		it('posts no picture for a player set to none', () => {
			const none = { ...config, avatars: { default: { kind: 'none' as const }, players: new Map() } };
			const { bridge, posts } = setup({ config: none });
			bridge.onLines(['[12:00:00] [Server thread/INFO]: <Steve> hi']);
			vi.advanceTimersByTime(1000);
			expect(posts[0]).not.toHaveProperty('avatarUrl');
		});
	});

	it('posts an error with its stack trace once the log goes quiet', () => {
		const { bridge, posts } = setup();
		bridge.onLines([
			'[12:00:00] [Server thread/ERROR]: Encountered an unexpected exception',
			'java.lang.IllegalStateException: boom',
		]);
		expect(posts).toEqual([]);
		bridge.onLines(['\tat net.minecraft.server.MinecraftServer.run(MinecraftServer.java:1)']);
		vi.advanceTimersByTime(999);
		expect(posts).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ webhook: ALERTS, username: 'Survival', droppable: false });
		expect(posts[0]!.content).toContain('java.lang.IllegalStateException: boom\n\tat net.minecraft');
	});

	it('holds back a repeated error and posts the count in the summary', () => {
		const gate = createAlertGate(DEFAULT_ALERT_GATE);
		const { bridge, posts } = setup({ gate });
		for (let i = 0; i < 3; i++) bridge.onLines([`[12:00:0${i}] [Server thread/ERROR]: Same thing broke`]);
		bridge.flush();
		expect(posts).toHaveLength(1);
		vi.advanceTimersByTime(DEFAULT_ALERT_GATE.dedupeWindowMs);
		bridge.postSummaries();
		expect(posts).toHaveLength(2);
		expect(posts[1]).toMatchObject({ webhook: ALERTS, droppable: false });
		expect(posts[1]!.content).toContain('Error repeated 2 more times: `Same thing broke`');
	});

	it('posts no summary when there is nothing to report', () => {
		const { bridge, posts } = setup();
		bridge.postSummaries();
		expect(posts).toEqual([]);
	});

	it("leaves out what the config's ignore patterns match", () => {
		const { bridge, posts } = setup({ config: { ...config, ignore: [...config.ignore, /Known harmless/] } });
		bridge.onLines(['[12:00:00] [Server thread/ERROR]: Known harmless thing']);
		bridge.flush();
		expect(posts).toEqual([]);
	});

	it('learns from the backlog whether the server is up, without posting it', () => {
		const { bridge, posts, log } = setup();
		bridge.onBacklog(fixture('vanilla-26.3-startup.log'));
		expect(log).toHaveBeenLastCalledWith('the existing log says Survival is up');
		bridge.onBacklog(fixture('vanilla-26.3-stopping.log'));
		expect(log).toHaveBeenLastCalledWith('the existing log says Survival is stopped');
		bridge.onBacklog('');
		expect(log).toHaveBeenLastCalledWith('no start or stop in the existing log yet');
		expect(posts).toEqual([]);
	});

	it('posts at most one read error alert per 10 minutes, logging every one', () => {
		const { bridge, posts, log } = setup();
		const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
		bridge.onReadError(eacces);
		vi.advanceTimersByTime(60_000);
		bridge.onReadError(eacces);
		expect(posts).toHaveLength(1);
		expect(log).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(9 * 60_000);
		bridge.onReadError(eacces);
		expect(posts).toHaveLength(2);
	});

	it('reports repeats still inside their window in the final summary', () => {
		const { bridge, posts } = setup();
		bridge.onLines(['[12:00:00] [Server thread/ERROR]: Same thing broke']);
		bridge.onLines(['[12:00:01] [Server thread/ERROR]: Same thing broke']);
		bridge.flush();
		bridge.postSummaries();
		expect(posts).toHaveLength(1);
		bridge.postSummaries({ final: true });
		expect(posts).toHaveLength(2);
		expect(posts[1]!.content).toContain('repeated 1 more time');
	});

	it('logs a failure while handling lines instead of throwing, and goes on', () => {
		const log = vi.fn<(message: string) => void>();
		const send = vi.fn().mockImplementationOnce(() => {
			throw new Error('sender broke');
		});
		const bridge = createBridge({ config, sender: { send }, log });
		expect(() =>
			bridge.onLines(['[12:00:00] [Server thread/INFO]: <Steve> one', '[12:00:01] [Server thread/INFO]: <Steve> two']),
		).not.toThrow();
		bridge.flush();
		expect(log).toHaveBeenCalledWith(expect.stringContaining('sender broke'));
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('escapes Markdown in the server name', () => {
		const { bridge, posts } = setup({ config: { ...config, serverName: 'My_SMP_' } });
		bridge.onLines(['[12:00:00] [Server thread/INFO]: Stopping server']);
		bridge.flush();
		expect(posts[0]!.content).toBe('🔴 **My\\_SMP\\_** is stopping');
		expect(posts[0]!.username).toBe('My_SMP_');
	});

	it('posts a crash report as an alert, and a crash loop once with a count', () => {
		const { bridge, posts } = setup();
		const report = fixture('vanilla-synthetic-crash-report.txt');
		bridge.onCrashReport('crash-2026-11-21_12.06.03-server.txt', report);
		bridge.onCrashReport('crash-2026-11-21_12.06.33-server.txt', report);
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ webhook: ALERTS, username: 'Survival', droppable: false });
		expect(posts[0]!.content).toBe(
			[
				'⚠️ **Survival**: Crashed (FATAL)',
				'```',
				'Exception in server tick loop',
				'java.lang.IllegalStateException: Example failure',
				'\tat net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:1000)',
				'\tat net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:900)',
				'\tat java.base/java.lang.Thread.run(Thread.java:1583)',
				'```',
				'Full report: `crash-2026-11-21_12.06.03-server.txt` in the crash-reports folder.',
			].join('\n'),
		);
		bridge.postSummaries({ final: true });
		expect(posts[1]!.content).toContain('Crashed repeated 1 more time: `Exception in server tick loop`');
	});

	it('still posts a crash report it could not make sense of', () => {
		const { bridge, posts } = setup();
		bridge.onCrashReport('crash-x-server.txt', '');
		expect(posts[0]!.content).toContain('A new crash report (no description in it)');
		expect(posts[0]!.content).toContain('`crash-x-server.txt`');
	});

	it('posts a crash-reports folder read error, rate-limited apart from the log', () => {
		const { bridge, posts } = setup({ config: { ...config, crashReportsDir: '/srv/crash-reports' } });
		const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
		bridge.onReadError(eacces);
		bridge.onCrashReportError(eacces);
		bridge.onCrashReportError(eacces);
		expect(posts.map(({ content }) => content)).toEqual([
			"⚠️ **Survival**: mcbridge can't read the server log (EACCES). Nothing is posted until it can.",
			"⚠️ **Survival**: mcbridge can't read the crash-reports folder (EACCES). Crashes aren't posted until it can.",
		]);
	});

	it('posts a log read error as an alert', () => {
		const { bridge, posts } = setup();
		bridge.onReadError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
		expect(posts).toEqual([
			{
				webhook: ALERTS,
				username: 'Survival',
				droppable: false,
				content: "⚠️ **Survival**: mcbridge can't read the server log (EACCES). Nothing is posted until it can.",
			},
		]);
	});
});
