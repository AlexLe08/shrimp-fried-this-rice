import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_ACCESS, createApp } from '../../src/dashboard/app.ts';
import type { AuthConfig } from '../../src/dashboard/auth.ts';
import { startSession } from '../../src/dashboard/sessions.ts';
import { __resetForTests } from '../../src/core/database.ts';
import {
	createGuildReminder,
	setGuildMasterEnabled,
	setGuildReminderEnabled,
	snoozeGuildReminder,
	updateGuildReminderLastSent,
} from '../../src/reminders/storage.ts';
import { fakeClient, fakeGuild } from './fakeGuilds.ts';

const auth: AuthConfig = { clientId: 'client-1', clientSecret: 'secret-1', origin: 'https://dash.example' };
const NOW = 1_000_000;

beforeEach(() => {
	__resetForTests();
});

function signedIn(userId = 'u1'): { Cookie: string } {
	return { Cookie: `__Host-session=${startSession({ id: userId, username: 'Alex' }, NOW).token}` };
}

describe('servers', () => {
	const shrimp = () => fakeGuild('g1', 'Shrimp Hall', { u1: true, u2: false });
	const other = () => fakeGuild('g2', 'Other Place', { u2: true });

	function serversApp(guilds = [shrimp(), other()]) {
		return createApp({ auth, client: fakeClient(guilds), now: () => NOW });
	}

	it('lists the servers the signed-in user manages, linking each', async () => {
		const text = await (await serversApp().request('/servers', { headers: signedIn() })).text();

		expect(text).toContain('<a href="/servers/g1">Shrimp Hall</a>');
		expect(text).not.toContain('Other Place');
	});

	it('says why the list is empty when the user manages none', async () => {
		const text = await (await serversApp().request('/servers', { headers: signedIn('u3') })).text();

		expect(text).toContain('No servers to show');
	});

	it('escapes server names', async () => {
		const app = serversApp([fakeGuild('g1', '<i>Shrimp</i>', { u1: true })]);

		const text = await (await app.request('/servers', { headers: signedIn() })).text();

		expect(text).toContain('&lt;i&gt;Shrimp&lt;/i&gt;');
		expect(text).not.toContain('<i>Shrimp');
	});

	it('links to the list from the home page once signed in', async () => {
		expect(await (await serversApp().request('/', { headers: signedIn() })).text()).toContain('href="/servers"');
	});

	it('shows a server the user manages, asking Discord once per request', async () => {
		const guild = shrimp();
		const response = await serversApp([guild]).request('/servers/g1', { headers: signedIn() });

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('<h1>Shrimp Hall</h1>');
		expect(guild.members.fetch).toHaveBeenCalledTimes(1);
	});

	it('answers 404 with the same page for a non-manager, a non-member, a server the bot is not in, and another server', async () => {
		const app = serversApp();
		const cases = [
			['g1', 'u2'],
			['g1', 'u3'],
			['g9', 'u1'],
			['g2', 'u1'],
		] as const;

		const responses = await Promise.all(
			cases.map(([guildId, userId]) => app.request(`/servers/${guildId}`, { headers: signedIn(userId) })),
		);

		expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
		const bodies = await Promise.all(responses.map((response) => response.text()));
		expect(bodies[0]).toContain('<h1>Not found</h1>');
		expect(new Set(bodies).size).toBe(1);
	});

	it('shows no servers without a client', async () => {
		const app = createApp({ auth, now: () => NOW });

		expect(await (await app.request('/servers', { headers: signedIn() })).text()).toContain('No servers to show');
		expect((await app.request('/servers/g1', { headers: signedIn() })).status).toBe(404);
	});
});

describe("a server's reminders", () => {
	async function page(channels: Record<string, string> = { c1: 'general' }): Promise<string> {
		const app = createApp({
			auth,
			client: fakeClient([fakeGuild('g1', 'Shrimp Hall', { u1: true }, channels)]),
			now: () => NOW,
		});
		return (await app.request('/servers/g1', { headers: signedIn() })).text();
	}

	function remind(label: string, options: { intervalMinutes?: number; embed?: boolean; guildId?: string } = {}) {
		createGuildReminder({
			guildId: options.guildId ?? 'g1',
			label,
			channelId: 'c1',
			intervalMinutes: options.intervalMinutes ?? 60,
			message: `${label} message`,
			embed: options.embed ?? true,
		});
	}

	it('says there are none yet, and how to add one', async () => {
		const text = await page();

		expect(text).toContain('0 reminders of 20');
		expect(text).toContain('No reminders yet');
		expect(text).toContain('Reminders are on for this server.');
	});

	it("shows a reminder's label, channel, interval, format and message, and when it is next sent", async () => {
		remind('water', { intervalMinutes: 120 });
		updateGuildReminderLastSent(1, NOW);

		const text = await page();

		expect(text).toContain('<h2>water</h2>');
		expect(text).toContain('Every 2 hours in #general, as an embed.');
		expect(text).toContain('<blockquote>water message</blockquote>');
		const at = new Date(NOW + 120 * 60_000).toISOString();
		expect(text).toContain(
			`Next <time datetime="${at}" title="${at.slice(0, 16).replace('T', ' ')} UTC">in 2 hours</time>.`,
		);
		expect(text).toContain('1 reminder of 20');
	});

	it('shows due, disabled and snoozed reminders, and plain-text ones', async () => {
		remind('due', { intervalMinutes: 90, embed: false });
		remind('off');
		setGuildReminderEnabled('g1', 'off', false);
		remind('nap', { intervalMinutes: 5 });
		snoozeGuildReminder('g1', 'nap', { until: NOW + 30 * 60_000, skipMissed: false, now: NOW });

		const text = await page();

		expect(text).toContain('Every 90 minutes in #general, as plain text.');
		expect(text).toContain('Due on the next check.');
		expect(text).toContain('Disabled.');
		expect(text).toMatch(/Snoozed, next <time [^>]+>in 30 minutes<\/time>\./);
	});

	it("shows every reminder as paused when the server's master toggle is off", async () => {
		remind('water');
		setGuildMasterEnabled('g1', false);

		const text = await page();

		expect(text).toContain('Reminders are off for this server');
		expect(text).toContain('Paused: this server&#39;s reminders are off.');
	});

	it("names a channel the bot can't see by its id", async () => {
		remind('water');

		expect(await page({})).toContain("in a channel the bot can't see (ID c1)");
	});

	it("shows only this server's reminders", async () => {
		remind('ours');
		remind('theirs', { guildId: 'g2' });

		const text = await page();

		expect(text).toContain('<h2>ours</h2>');
		expect(text).not.toContain('theirs');
	});

	it('escapes labels, messages and channel names', async () => {
		remind('<b>label</b>');

		const text = await page({ c1: '<i>chan</i>' });

		expect(text).toContain('&lt;b&gt;label&lt;/b&gt;');
		expect(text).toContain('#&lt;i&gt;chan&lt;/i&gt;');
		expect(text).not.toMatch(/<b>|<i>/);
	});
});

// Decision 0009: deny by default. A route missing from ROUTE_ACCESS, or one
// listed but not served, fails here, and every non-public route is tried
// signed out and, for a server's routes, as a manager of another server.
describe('route access', () => {
	const app = createApp({ auth, client: fakeClient([fakeGuild('g1', 'Shrimp Hall', { u2: true })]), now: () => NOW });
	const served = [...new Set(app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))];
	const declared = Object.entries(ROUTE_ACCESS);

	it('declares the access of every route the app serves, and serves every route it declares', () => {
		expect(served.sort()).toEqual(Object.keys(ROUTE_ACCESS).sort());
	});

	// Middleware is registered for every method (ALL); a handler registered
	// that way (app.all) would escape the check above, so only these may be.
	it('registers nothing for every method but the middleware', () => {
		const everyMethod = new Set(app.routes.filter((r) => r.method === 'ALL').map((r) => r.path));

		expect([...everyMethod].sort()).toEqual(['/*', '/servers', '/servers/:guildId/*']);
	});

	it('keeps every server route under /servers/:guildId, where the guard runs', () => {
		for (const [route, access] of declared) {
			if (access === 'server') expect(route.split(' ')[1]).toMatch(/^\/servers\/:guildId(\/|$)/);
		}
	});

	const withGuild = (route: string) => {
		const [method, path] = route.split(' ') as [string, string];
		return { method, path: path.replace(':guildId', 'g1') };
	};

	it.each(declared.filter(([, access]) => access !== 'public').map(([route]) => route))(
		'sends a signed-out visitor of %s back to the home page',
		async (route) => {
			const { method, path } = withGuild(route);

			const response = await app.request(path, { method });

			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toBe('/');
		},
	);

	it.each(declared.filter(([, access]) => access === 'server').map(([route]) => route))(
		'answers 404 for %s to a user who manages only another server',
		async (route) => {
			const { method, path } = withGuild(route);

			const response = await app.request(path, { method, headers: signedIn('u1') });

			expect(response.status).toBe(404);
		},
	);
});
