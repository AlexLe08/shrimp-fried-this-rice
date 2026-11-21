import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlertGate, DEFAULT_ALERT_GATE } from '../../../src/minecraft/bridge/alertGate.ts';
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
