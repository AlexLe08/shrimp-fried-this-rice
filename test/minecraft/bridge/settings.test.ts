import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AVATARS } from '../../../src/minecraft/bridge/avatars.ts';
import { DEFAULT_IGNORE } from '../../../src/minecraft/bridge/classify.ts';
import type { BridgeConfig } from '../../../src/minecraft/bridge/config.ts';
import {
	applySettings,
	createSettingsSaver,
	loadCachedSettings,
	readSettings,
	saveSettings,
	settingsCachePath,
} from '../../../src/minecraft/bridge/settings.ts';
import { DEFAULT_STYLE } from '../../../src/minecraft/bridge/toMinecraft.ts';

const BRIDGE = 'AAECAwQFBgcICQoLDA0ODw';
const SENT = {
	kind: 'settings',
	serverName: 'Creative',
	prefix: '[DC]',
	colour: 'gold',
	defaultPicture: 'skin',
	pictures: [
		{ name: 'Steve', picture: 'generated:3' },
		{ name: 'Alex', picture: 'none' },
	],
};

const config: BridgeConfig = {
	serverName: 'Survival',
	logPath: '/srv/logs/latest.log',
	webhooks: { chat: 'https://discord.com/api/webhooks/1/a', alerts: 'https://discord.com/api/webhooks/2/b' },
	ignore: [...DEFAULT_IGNORE],
	avatars: {
		default: { kind: 'generated' },
		players: new Map([
			['steve', { kind: 'url' as const, url: 'https://example.com/steve.png' }],
			['notch', { kind: 'skin' as const }],
		]),
	},
};

describe('readSettings', () => {
	it('reads what the bot sends', () => {
		const log = vi.fn();
		expect(readSettings(SENT, log)).toEqual({
			serverName: 'Creative',
			prefix: '[DC]',
			colour: 'gold',
			defaultPicture: { kind: 'skin' },
			pictures: new Map([
				['steve', { kind: 'generated', index: 3 }],
				['alex', { kind: 'none' }],
			]),
		});
		expect(log).not.toHaveBeenCalled();
		expect(readSettings({ ...SENT, defaultPicture: null }, log)?.defaultPicture).toBeNull();
		// A bot of another version leaving a field out: the config's stands, and it isn't a problem to log.
		expect(readSettings({ serverName: 'Creative' }, log)).toEqual({ serverName: 'Creative' });
		expect(log).not.toHaveBeenCalled();
	});

	it("drops each field the dashboard wouldn't accept, links included, logging which", () => {
		const log = vi.fn();
		const read = readSettings(
			{
				serverName: 'my discord server',
				prefix: '<Discord>',
				colour: 'pink',
				defaultPicture: 'https://example.com/x.png',
				pictures: [{ name: 'Steve', picture: 'generated:99' }, { name: 'bad name!', picture: 'skin' }, null],
			},
			log,
		);

		expect(read).toEqual({ pictures: new Map() });
		expect(log).toHaveBeenCalledWith(
			"kept the config's values for settings the bot sent that aren't valid: serverName, prefix, colour, defaultPicture, a picture, a picture, a picture",
		);
		expect(readSettings('nope', log)).toBeNull();
	});
});

describe('applySettings', () => {
	it("puts the dashboard's settings over the config's, its pictures winning for the same name", () => {
		const live = applySettings(
			config,
			readSettings(SENT, () => {}),
		);

		expect(live.serverName).toBe('Creative');
		expect(live.style).toEqual({ prefix: '[DC]', colour: 'gold' });
		expect(live.avatars.default).toEqual({ kind: 'skin' });
		expect(live.avatars.players).toEqual(
			new Map<string, unknown>([
				['steve', { kind: 'generated', index: 3 }],
				['notch', { kind: 'skin' }],
				['alex', { kind: 'none' }],
			]),
		);
		// The config itself is left as it was, for the next settings to start from.
		expect(config.avatars.players.get('steve')).toEqual({ kind: 'url', url: 'https://example.com/steve.png' });
	});

	it("keeps the config's values where the dashboard sets none, and before the bot has answered", () => {
		const live = applySettings(
			config,
			readSettings({ ...SENT, defaultPicture: null, pictures: [] }, () => {}),
		);
		expect(live.avatars.default).toEqual({ kind: 'generated' });

		expect(applySettings(config, null)).toEqual({
			serverName: 'Survival',
			style: DEFAULT_STYLE,
			avatars: config.avatars,
		});
		expect(applySettings({ ...config, avatars: DEFAULT_AVATARS }, null).avatars.players.size).toBe(0);
	});
});

describe('the settings cache', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'mcbridge-settings-'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('sits beside the config, named after it', () => {
		expect(settingsCachePath('/srv/mc/mcbridge.json')).toBe('/srv/mc/mcbridge.settings.json');
		expect(settingsCachePath('/srv/mc/creative.json')).toBe('/srv/mc/creative.settings.json');
		expect(settingsCachePath('/srv/mc/config')).toBe('/srv/mc/config.settings.json');
	});

	it('keeps what the bot sent for the next start, replacing the file whole', async () => {
		const path = join(dir, 'mcbridge.settings.json');
		await saveSettings(path, BRIDGE, SENT);
		await saveSettings(path, BRIDGE, { ...SENT, serverName: 'Hardcore' });

		expect((await loadCachedSettings(path, BRIDGE, () => {}))?.serverName).toBe('Hardcore');
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
			bridge: BRIDGE,
			settings: { ...SENT, serverName: 'Hardcore' },
		});
		expect(await readdir(dir)).toEqual(['mcbridge.settings.json']);
	});

	it("ignores another bridge's settings, a broken file, or none, quietly unless it's broken", async () => {
		const path = join(dir, 'mcbridge.settings.json');
		const log = vi.fn();
		expect(await loadCachedSettings(path, BRIDGE, log)).toBeNull();
		expect(log).not.toHaveBeenCalled();

		await saveSettings(path, 'BBECAwQFBgcICQoLDA0ODw', SENT);
		expect(await loadCachedSettings(path, BRIDGE, log)).toBeNull();

		await writeFile(path, '{ not json');
		expect(await loadCachedSettings(path, BRIDGE, log)).toBeNull();
		expect(log).toHaveBeenCalledWith(`${path} isn't valid JSON; ignoring it until the bot sends the settings again`);
	});

	it('saves one at a time in the order sent, so the later settings are the ones kept', async () => {
		const path = join(dir, 'mcbridge.settings.json');
		const save = createSettingsSaver(path, BRIDGE, () => {});

		void save({
			...SENT,
			serverName: 'First',
			pictures: Array.from({ length: 50 }, (_, i) => ({ name: `p${i}`, picture: 'skin' })),
		});
		await save({ ...SENT, serverName: 'Second' });

		expect((await loadCachedSettings(path, BRIDGE, () => {}))?.serverName).toBe('Second');
		expect(await readdir(dir)).toEqual(['mcbridge.settings.json']);
	});

	it('logs a save that fails, and the next still goes', async () => {
		const log = vi.fn();
		const save = createSettingsSaver(join(dir, 'missing', 'mcbridge.settings.json'), BRIDGE, log);

		await save(SENT);

		expect(log).toHaveBeenCalledWith(expect.stringMatching(/^can't save the bridge settings to .*ENOENT/));
	});
});
