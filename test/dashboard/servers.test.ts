import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_ACCESS, createApp } from '../../src/dashboard/app.ts';
import type { AuthConfig } from '../../src/dashboard/auth.ts';
import { startSession } from '../../src/dashboard/sessions.ts';
import { __resetForTests } from '../../src/core/database.ts';
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
