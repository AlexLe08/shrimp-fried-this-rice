import { describe, expect, it } from 'vitest';
import { checkPictureChange, checkSettingsChange } from '../../src/minecraft/bridgeSettings.ts';
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

describe('checkPictureChange', () => {
	it.each(['generated', 'generated:0', 'generated:9', 'skin', 'none'])(
		'takes %s for a player, trimming the name',
		(picture) => {
			expect(checkPictureChange({ name: ' Steve_2 ', picture })).toEqual({
				ok: true,
				change: { name: 'Steve_2', picture },
			});
		},
	);

	it('takes an empty picture as removing it', () => {
		expect(checkPictureChange({ name: 'Steve', picture: '' })).toEqual({
			ok: true,
			change: { name: 'Steve', picture: null },
		});
	});

	it.each([
		['an empty name', { name: '  ' }, ['name']],
		['a name over 16 characters', { name: 'x'.repeat(17) }, ['name']],
		['a name with a space', { name: 'Steve Two' }, ['name']],
		['a name with a hyphen', { name: 'Steve-2' }, ['name']],
		['a generated picture past the last', { picture: 'generated:10' }, ['picture']],
		['a link', { picture: 'https://example.com/a.png' }, ['picture']],
		['a link picture, as linked players choose', { picture: 'discord' }, ['picture']],
		['both', { name: '<b>', picture: 'default' }, ['name', 'picture']],
	])('refuses %s', (_what, change, refused) => {
		expect(checkPictureChange({ name: 'Steve', picture: 'skin', ...change })).toEqual({ ok: false, refused });
	});

	// As for the settings: the helper drops a picture it would refuse.
	it('saves only pictures the helper accepts', () => {
		const logs: string[] = [];
		const pictures = ['generated', 'generated:0', 'generated:9', 'skin', 'none'].map((picture, i) => {
			const checked = checkPictureChange({ name: `Steve${i}`, picture });
			if (!checked.ok) throw new Error('refused');
			return checked.change;
		});

		const read = readSettings({ pictures }, (message) => logs.push(message));

		expect(logs).toEqual([]);
		expect(read?.pictures?.size).toBe(5);
		expect(read?.pictures?.get('steve1')).toEqual({ kind: 'generated', index: 0 });
	});
});
