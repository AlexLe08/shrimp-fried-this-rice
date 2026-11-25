import { describe, expect, it } from 'vitest';
import { checkSettingsChange } from '../../src/minecraft/bridgeSettings.ts';
import { readSettings } from '../../src/minecraft/bridge/settings.ts';

const valid = { serverName: 'Survival', prefix: '[Discord]', colour: '#5865F2', defaultPicture: '' };

describe('checkSettingsChange', () => {
	it('takes valid settings, trimmed, with no default picture as the config’s', () => {
		expect(
			checkSettingsChange({ serverName: '  Survival ', prefix: ' [DC] ', colour: ' Gold ', defaultPicture: '' }),
		).toEqual({ ok: true, change: { serverName: 'Survival', prefix: '[DC]', colour: 'gold', defaultPicture: null } });
	});

	it.each(['generated', 'skin', 'none'])('takes %s as the default picture', (defaultPicture) => {
		expect(checkSettingsChange({ ...valid, defaultPicture })).toMatchObject({ ok: true, change: { defaultPicture } });
	});

	it('names every field it refuses', () => {
		expect(
			checkSettingsChange({ serverName: 'Discord SMP', prefix: '<DC>', colour: 'pink', defaultPicture: 'generated:3' }),
		).toEqual({ ok: false, refused: ['serverName', 'prefix', 'colour', 'defaultPicture'] });
	});

	it.each([
		['an empty name', { serverName: '   ' }, 'serverName'],
		['a name over 80 characters', { serverName: 'x'.repeat(81) }, 'serverName'],
		['an empty prefix', { prefix: '' }, 'prefix'],
		['a prefix a player name could start', { prefix: 'Discord' }, 'prefix'],
		['the [Not Secure] prefix', { prefix: '[Not Secure]' }, 'prefix'],
		['a hex colour without #', { colour: '5865F2' }, 'colour'],
		['a link as the default picture', { defaultPicture: 'https://example.com/a.png' }, 'defaultPicture'],
	])('refuses %s', (_what, change, field) => {
		expect(checkSettingsChange({ ...valid, ...change })).toEqual({ ok: false, refused: [field] });
	});

	// The helper drops any field it would refuse, so what the dashboard saves
	// must pass its check.
	it('saves only what the helper accepts', () => {
		const logs: string[] = [];
		for (const defaultPicture of ['', 'generated', 'skin', 'none']) {
			const checked = checkSettingsChange({ ...valid, colour: 'DARK_AQUA', defaultPicture });
			if (!checked.ok) throw new Error('refused');

			expect(readSettings(checked.change, (message) => logs.push(message))).toMatchObject({
				serverName: 'Survival',
				prefix: '[Discord]',
				colour: 'dark_aqua',
			});
		}
		expect(logs).toEqual([]);
	});
});
