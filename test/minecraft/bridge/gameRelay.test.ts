import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GAME_CHAT_PER_SECOND,
	MAX_QUEUED_CHAT,
	createGameRelay,
	weakPasswordReason,
	type GameRelayOptions,
	type RelayOffReason,
} from '../../../src/minecraft/bridge/gameRelay.ts';
import type { RconOptions } from '../../../src/minecraft/bridge/rcon.ts';

const PASSWORD = 'k3Vq-9xTz-Lw2p';
const PROPERTIES = `enable-rcon=true\nrcon.port=25580\nrcon.password=${PASSWORD}\nonline-mode=false\n`;

beforeEach(() => {
	vi.useFakeTimers({ now: 1_790_000_000_000 });
});

afterEach(() => {
	vi.useRealTimers();
});

function setup(properties: string | Error = PROPERTIES, extra: Partial<GameRelayOptions> = {}) {
	const sent: { command: string; at: number }[] = [];
	const rcons: { options: RconOptions; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
	let accepts = true;
	const createRcon = vi.fn((rconOptions: RconOptions) => {
		const rcon = {
			options: rconOptions,
			start: vi.fn(),
			stop: vi.fn(),
			send: vi.fn(async (command: string) => {
				sent.push({ command, at: Date.now() });
				return accepts;
			}),
		};
		rcons.push(rcon);
		return rcon;
	});
	const alert = vi.fn<(reason: RelayOffReason, message: string) => void>();
	const log = vi.fn();
	const readFile = vi.fn(async () => {
		if (properties instanceof Error) throw properties;
		return new TextEncoder().encode(properties);
	});
	const relay = createGameRelay({
		propertiesPath: '/srv/mc/server.properties',
		alert,
		log,
		readFile,
		createRcon: createRcon as never,
		...extra,
	});
	return { relay, sent, rcons, alert, log, readFile, refuse: () => (accepts = false) };
}

const chat = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ kind: 'chat' as const, name: 'Alex', text: `m${i}` }));

describe('weakPasswordReason', () => {
	it.each([
		['short1', "it's under 12 characters"],
		['aaaaaaaaaaaaaaaa', 'it repeats a few characters'],
		['123123123123', 'it repeats a few characters'],
		['minecraftserver', "it's built from common words"],
		['Password2024!!', "it's built from common words"],
		['RconRconRcon42', "it's built from common words"],
	])('refuses %s', (password, reason) => {
		expect(weakPasswordReason(password)).toBe(reason);
	});

	it('accepts a long, varied one, counting characters as the file decodes them', () => {
		expect(weakPasswordReason(PASSWORD)).toBeNull();
		expect(weakPasswordReason('minecraft-k3Vq9xTz')).toBeNull();
		// 12 code points (⛏️ is two: the pick and a variation selector), though more UTF-16 units.
		expect(weakPasswordReason('🔑🌲🪓⛏️ab12cde')).toBeNull();
	});
});

describe('the game relay', () => {
	it('connects RCON from server.properties at each start, on 127.0.0.1, and reads online-mode', async () => {
		const { relay, rcons, readFile } = setup();
		expect(relay.onlineMode()).toBe(true);

		await relay.serverUp();

		expect(readFile).toHaveBeenCalledWith('/srv/mc/server.properties');
		expect(rcons[0]!.options).toMatchObject({ host: '127.0.0.1', port: 25580, password: PASSWORD });
		expect(rcons[0]!.start).toHaveBeenCalledOnce();
		expect(relay.isOn()).toBe(true);
		expect(relay.onlineMode()).toBe(false);

		relay.serverDown();
		await relay.serverUp();
		expect(rcons[0]!.stop).toHaveBeenCalled();
		expect(rcons).toHaveLength(2);
	});

	it("uses the config's rcon host and port over the file's", async () => {
		const { relay, rcons } = setup(PROPERTIES, { rconOverride: { host: '172.17.0.2', port: 25575 } });
		await relay.serverUp();

		expect(rcons[0]!.options).toMatchObject({ host: '172.17.0.2', port: 25575 });
	});

	it(`sends chat as tellraw in order, at most ${GAME_CHAT_PER_SECOND} a second`, async () => {
		const { relay, sent } = setup();
		await relay.serverUp();
		const start = Date.now();

		relay.relay(chat(7));
		await vi.advanceTimersByTimeAsync(2000);

		expect(sent.map((s) => s.command.match(/m\d/)![0])).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
		expect(sent.map((s) => s.at - start)).toEqual([0, 200, 400, 600, 800, 1000, 1200]);
		expect(sent[0]!.command).toMatch(/^tellraw @a /);
	});

	it('drops chat while the server is down, and what was waiting when it stops', async () => {
		const { relay, sent } = setup();
		relay.relay(chat(1));
		expect(sent).toHaveLength(0);

		await relay.serverUp();
		relay.relay(chat(5));
		relay.serverDown();
		await vi.advanceTimersByTimeAsync(2000);
		// The first had already gone; the rest were dropped, not kept for the next start.
		expect(sent).toHaveLength(1);

		await relay.serverUp();
		await vi.advanceTimersByTimeAsync(2000);
		expect(sent).toHaveLength(1);
	});

	it(`drops chat past ${MAX_QUEUED_CHAT} waiting, and logs how many didn't go in`, async () => {
		const { relay, sent, log } = setup();
		await relay.serverUp();

		relay.relay(chat(MAX_QUEUED_CHAT + 10));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(sent).toHaveLength(MAX_QUEUED_CHAT);
		expect(log).toHaveBeenCalledWith("10 message(s) from Discord couldn't be sent to the game");
	});

	it('stays off, with one alert naming the fix, for each way server.properties keeps RCON off', async () => {
		const cases: [string | Error, RelayOffReason][] = [
			[Object.assign(new Error('nope'), { code: 'ENOENT' }), 'unreadable'],
			['enable-rcon=false\n', 'disabled'],
			['enable-rcon=true\nrcon.password=\n', 'no-password'],
			[`enable-rcon=true\nrcon.port=70000\nrcon.password=${PASSWORD}\n`, 'bad-port'],
			['enable-rcon=true\nrcon.password=minecraft\n', 'weak-password'],
		];
		for (const [properties, reason] of cases) {
			const { relay, rcons, alert, sent } = setup(properties);
			await relay.serverUp();
			relay.relay(chat(1));
			await relay.serverUp();

			expect(rcons).toHaveLength(0);
			expect(relay.isOn()).toBe(false);
			expect(alert).toHaveBeenCalledOnce();
			expect(alert.mock.calls[0]![0]).toBe(reason);
			expect(sent).toHaveLength(0);
		}
	});

	it('never quotes the password in a weak-password alert', async () => {
		const { relay, alert } = setup('enable-rcon=true\nrcon.password=Password2024!!\n');
		await relay.serverUp();

		expect(alert.mock.calls[0]![1]).toContain("it's built from common words");
		expect(alert.mock.calls[0]![1]).not.toContain('Password2024');
	});

	it('turns off, with an alert, when the server refuses the password', async () => {
		const { relay, rcons, alert } = setup();
		await relay.serverUp();

		rcons[0]!.options.onLoginRefused!();

		expect(relay.isOn()).toBe(false);
		expect(alert).toHaveBeenCalledExactlyOnceWith('login-refused', expect.stringContaining('refused rcon.password'));
	});

	it("doesn't connect when the server stopped while server.properties was being read", async () => {
		let finish!: () => void;
		const { relay, rcons, readFile } = setup();
		readFile.mockImplementationOnce(
			() => new Promise((resolve) => (finish = () => resolve(new TextEncoder().encode(PROPERTIES)))),
		);

		const starting = relay.serverUp();
		relay.serverDown();
		finish();
		await starting;

		expect(rcons).toHaveLength(0);
	});

	it("counts chat RCON couldn't send, and closes everything when the helper stops", async () => {
		const { relay, rcons, log, refuse } = setup();
		await relay.serverUp();
		refuse();

		relay.relay(chat(2));
		await vi.advanceTimersByTimeAsync(1000);
		expect(log).toHaveBeenCalledWith("2 message(s) from Discord couldn't be sent to the game");

		relay.close();
		expect(rcons[0]!.stop).toHaveBeenCalled();
		expect(relay.isOn()).toBe(false);
	});
});
