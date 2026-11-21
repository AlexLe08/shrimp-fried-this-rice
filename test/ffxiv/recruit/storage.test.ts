import { describe, it, expect, beforeEach } from 'vitest';
import {
	addRecruit,
	deleteRecruit,
	getDueRecruits,
	getOpenRecruitByName,
	getOpenRecruitCount,
	getOpenRecruits,
	getRecruitSettings,
	markRecruitReminded,
	pauseRecruitFollowUps,
	recruitNameKey,
	resolveRecruit,
	setRecruitSettings,
	updateRecruit,
} from '../../../src/ffxiv/recruit/storage.ts';
import { __resetForTests } from '../../../src/core/database.ts';

beforeEach(() => {
	__resetForTests();
});

function add(name: string, overrides: { guildId?: string; dueAt?: number; note?: string } = {}) {
	return addRecruit({
		guildId: overrides.guildId ?? 'g1',
		name,
		note: overrides.note ?? '',
		addedBy: 'mod1',
		addedAt: 1_000,
		dueAt: overrides.dueAt ?? 5_000,
	});
}

describe('recruit settings', () => {
	it('needs a channel the first time, and saves nothing without one', () => {
		expect(setRecruitSettings('g1', { followUpDays: 10 })).toBeUndefined();
		expect(getRecruitSettings('g1')).toBeUndefined();
	});

	it('defaults to 30 days and no role, and keeps settings that a later call leaves out', () => {
		expect(setRecruitSettings('g1', { channelId: 'c1' })).toMatchObject({
			channel_id: 'c1',
			ping_role_id: null,
			follow_up_days: 30,
			enabled: 1,
		});
		setRecruitSettings('g1', { pingRoleId: 'r1', followUpDays: 14 });
		expect(setRecruitSettings('g1', { channelId: 'c2' })).toMatchObject({
			channel_id: 'c2',
			ping_role_id: 'r1',
			follow_up_days: 14,
		});
		expect(setRecruitSettings('g1', { pingRoleId: null })?.ping_role_id).toBeNull();
	});

	it('pauses only while the channel is the one that failed, and any later setting resumes', () => {
		setRecruitSettings('g1', { channelId: 'c1' });
		pauseRecruitFollowUps('g1', 'c-old');
		expect(getRecruitSettings('g1')?.enabled).toBe(1);

		pauseRecruitFollowUps('g1', 'c1');
		expect(getRecruitSettings('g1')?.enabled).toBe(0);

		expect(setRecruitSettings('g1', { followUpDays: 7 })?.enabled).toBe(1);
	});
});

describe('recruits', () => {
	it('stores the name trimmed as typed and finds it however it is capitalised', () => {
		const recruit = add('  Alex Le ', { note: 'met in Limsa' });

		expect(recruit).toMatchObject({
			guild_id: 'g1',
			name: 'Alex Le',
			name_key: 'alex le',
			note: 'met in Limsa',
			added_by: 'mod1',
			added_at: 1_000,
			due_at: 5_000,
			status: 'pending',
			resolved_by: null,
		});
		expect(getOpenRecruitByName('g1', 'ALEX LE ')?.id).toBe(recruit.id);
		expect(getOpenRecruitByName('g2', 'Alex Le')).toBeUndefined();
		expect(recruitNameKey(' Alex LE ')).toBe('alex le');
	});

	it('refuses a name already open in the server, but not in another server', () => {
		add('Alex Le');
		expect(() => add('alex le')).toThrow(/UNIQUE/);
		expect(() => add('Alex Le', { guildId: 'g2' })).not.toThrow();
	});

	it('takes a name again once its entry is resolved', () => {
		const first = add('Alex Le');
		expect(resolveRecruit(first.id, 'left', 'mod2', 9_000)).toBe(true);

		const again = add('Alex Le');
		expect(again.id).not.toBe(first.id);
		expect(getOpenRecruitByName('g1', 'Alex Le')?.id).toBe(again.id);
	});

	it('lists and counts open entries only, soonest due first', () => {
		add('Later', { dueAt: 9_000 });
		add('Sooner', { dueAt: 2_000 });
		resolveRecruit(add('Done').id, 'promoted', 'mod2', 3_000);
		add('Elsewhere', { guildId: 'g2' });

		expect(getOpenRecruits('g1').map((r) => r.name)).toEqual(['Sooner', 'Later']);
		expect(getOpenRecruitCount('g1')).toBe(2);
	});

	it('records who resolved an entry and when, once', () => {
		const recruit = add('Alex Le');

		expect(resolveRecruit(recruit.id, 'promoted', 'mod2', 7_000)).toBe(true);
		expect(resolveRecruit(recruit.id, 'left', 'mod3', 8_000)).toBe(false);
		expect(getOpenRecruits('g1')).toEqual([]);
	});

	it('updates the name, note and due date, keeping what is left out', () => {
		const recruit = add('Alex Le', { note: 'old' });

		expect(updateRecruit(recruit.id, { note: 'new' })).toMatchObject({ name: 'Alex Le', note: 'new', due_at: 5_000 });
		expect(updateRecruit(recruit.id, { name: ' Alex Li ' })).toMatchObject({
			name: 'Alex Li',
			name_key: 'alex li',
			note: 'new',
		});
	});

	it('makes a reminded entry pending again when its due date changes, and only then', () => {
		const recruit = add('Alex Le');
		markRecruitReminded(recruit.id, recruit.due_at);

		expect(updateRecruit(recruit.id, { note: 'still here' })?.status).toBe('reminded');
		expect(updateRecruit(recruit.id, { dueAt: recruit.due_at })?.status).toBe('reminded');
		expect(updateRecruit(recruit.id, { dueAt: 20_000 })).toMatchObject({ status: 'pending', due_at: 20_000 });
	});

	it("doesn't update a resolved entry, or rename onto another open name", () => {
		const resolved = add('Gone');
		resolveRecruit(resolved.id, 'left', 'mod2', 2_000);
		expect(updateRecruit(resolved.id, { note: 'x' })).toBeUndefined();

		add('Taken');
		const other = add('Other');
		expect(() => updateRecruit(other.id, { name: 'taken' })).toThrow(/UNIQUE/);
	});

	it('deletes an entry', () => {
		deleteRecruit(add('Mistake').id);
		expect(getOpenRecruitByName('g1', 'Mistake')).toBeUndefined();
	});
});

describe('due follow-ups', () => {
	it('returns pending entries that are due, with where to post them', () => {
		setRecruitSettings('g1', { channelId: 'c1', pingRoleId: 'r1' });
		add('Due', { dueAt: 5_000 });
		add('Not yet', { dueAt: 5_001 });
		markRecruitReminded(add('Posted', { dueAt: 1_000 }).id, 1_000);
		resolveRecruit(add('Resolved', { dueAt: 1_000 }).id, 'left', 'mod2', 2_000);

		expect(getDueRecruits(5_000)).toEqual([
			expect.objectContaining({ name: 'Due', channel_id: 'c1', ping_role_id: 'r1' }),
		]);
	});

	it('holds them back in a server with no settings, or paused, until /recruit config', () => {
		add('Unconfigured', { guildId: 'g2' });
		setRecruitSettings('g1', { channelId: 'c1' });
		add('Paused');
		pauseRecruitFollowUps('g1', 'c1');

		expect(getDueRecruits(10_000)).toEqual([]);

		setRecruitSettings('g1', {});
		expect(getDueRecruits(10_000).map((r) => r.name)).toEqual(['Paused']);
	});

	it("marks an entry reminded only if its due date hasn't changed since it was read", () => {
		const recruit = add('Alex Le', { dueAt: 5_000 });
		updateRecruit(recruit.id, { dueAt: 50_000 });

		markRecruitReminded(recruit.id, 5_000);
		expect(getOpenRecruitByName('g1', 'Alex Le')?.status).toBe('pending');

		markRecruitReminded(recruit.id, 50_000);
		expect(getOpenRecruitByName('g1', 'Alex Le')?.status).toBe('reminded');
	});
});
