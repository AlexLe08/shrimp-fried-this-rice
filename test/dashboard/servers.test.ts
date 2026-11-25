import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createBridge, markBridgeAnnounced, setAllowedRole } from '../../src/minecraft/storage.ts';
import { fakeClient, fakeGuild } from './fakeGuilds.ts';
import { fakePairing } from './fakePairing.ts';
import type { BridgePairing, PairAnswer } from '../../src/minecraft/dashboardPairing.ts';

const auth: AuthConfig = { clientId: 'client-1', clientSecret: 'secret-1', origin: 'https://dash.example' };
const NOW = 1_000_000;

beforeEach(() => {
	__resetForTests();
	// Requests here come without CF-Connecting-IP, which the app warns of once.
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
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

	it('lists a server where the user manages only Minecraft bridges, linking its Minecraft page', async () => {
		const app = serversApp([fakeGuild('g1', 'Shrimp Hall', { u1: false }, {}, { ownerId: 'u1' })]);

		const text = await (await app.request('/servers', { headers: signedIn() })).text();

		expect(text).toContain('<a href="/servers/g1/minecraft">Shrimp Hall</a> (Minecraft servers)');
		expect(text).not.toContain('href="/servers/g1"');
	});

	it('links both pages of a server where the user has both rights', async () => {
		setAllowedRole('g1', 'r-mc');
		const app = serversApp([fakeGuild('g1', 'Shrimp Hall', { u1: true }, {}, { roles: { u1: ['r-mc'] } })]);

		const text = await (await app.request('/servers', { headers: signedIn() })).text();

		expect(text).toContain('<a href="/servers/g1">Shrimp Hall</a>');
		expect(text).toContain('<a href="/servers/g1/minecraft">Minecraft servers</a>');
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
		expect(text).toContain('Every 2 hours in #general, set to an embed.');
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

		expect(text).toContain('Every 90 minutes in #general, set to plain text.');
		expect(text).toContain('Due on the next check.');
		expect(text).toContain('Disabled.');
		expect(text).toMatch(/Snoozed, next <time [^>]+>in 30 minutes<\/time>\./);
	});

	// Through a snooze, as only a snooze (up to a week) runs past a day.
	it.each([
		[20_000, 'in under a minute'],
		[60_000, 'in 1 minute'],
		[60 * 60_000, 'in 60 minutes'],
		[119.5 * 60_000, 'in 2 hours'],
		[36 * 60 * 60_000, 'in 36 hours'],
		[3 * 24 * 60 * 60_000, 'in 3 days'],
	])('words a time %i ms ahead as "%s"', async (ahead, words) => {
		remind('nap', { intervalMinutes: 5 });
		snoozeGuildReminder('g1', 'nap', { until: NOW + ahead, skipMissed: false, now: NOW });

		expect(await page()).toMatch(new RegExp(`Snoozed, next <time [^>]+>${words}</time>\\.`));
	});

	it.each([
		[60, 'Every 1 hour'],
		[1440, 'Every 24 hours'],
		[5, 'Every 5 minutes'],
	])('words an interval of %i minutes as "%s"', async (minutes, words) => {
		remind('water', { intervalMinutes: minutes });

		expect(await page()).toContain(`${words} in #general`);
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

describe("a server's Minecraft servers", () => {
	// Each paired after the last, as bridges are listed by when they were paired.
	let paired = 0;
	function bridge(serverName: string, guildId = 'g1', chat = 'c1') {
		return createBridge({
			guildId,
			chat: { channelId: chat, webhookId: 'wh-chat', token: 'tok-chat' },
			alerts: { channelId: 'c2', webhookId: 'wh-alerts', token: 'tok-alerts' },
			keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
			serverName,
			now: NOW + paired++,
		});
	}

	async function page(channels: Record<string, string> = { c1: 'mc-chat', c2: 'mc-alerts' }): Promise<string> {
		const app = createApp({
			auth,
			client: fakeClient([fakeGuild('g1', 'Shrimp Hall', { u1: false }, channels, { ownerId: 'u1' })]),
			now: () => NOW,
		});
		const response = await app.request('/servers/g1/minecraft', { headers: signedIn() });
		expect(response.status).toBe(200);
		return response.text();
	}

	it('says none are paired yet', async () => {
		const text = await page();

		expect(text).toContain('<h1>Shrimp Hall: Minecraft servers</h1>');
		expect(text).toContain('0 Minecraft servers of 10 paired');
		expect(text).toContain('No Minecraft servers paired yet.');
	});

	it("shows each bridge's name and channels, and whether its chat goes into the game", async () => {
		bridge('Survival');
		const creative = bridge('Creative');
		markBridgeAnnounced(creative.id, 'c1');

		const text = await page();

		expect(text).toContain('2 Minecraft servers of 10 paired');
		expect(text).toMatch(/<h2>Survival<\/h2>[\s\S]*don&#39;t go into the game yet[\s\S]*<h2>Creative<\/h2>/);
		expect(text).toContain('Chat in #mc-chat, alerts in #mc-alerts.');
		expect(text).toMatch(/<h2>Creative<\/h2>[\s\S]*Messages posted in its chat channel go into the game\./);
	});

	it('counts a relay announced in a channel the chat has since left as not announced', async () => {
		markBridgeAnnounced(bridge('Survival', 'g1', 'c3').id, 'c1');

		expect(await page()).toContain('don&#39;t go into the game yet');
	});

	it("names a channel the bot can't see by its id", async () => {
		bridge('Survival');

		expect(await page({ c2: 'mc-alerts' })).toContain("Chat in a channel the bot can't see (ID c1)");
	});

	it("shows only this server's bridges, escaping names", async () => {
		bridge('<b>Survival</b>');
		bridge('Theirs', 'g2');

		const text = await page({ c1: '<i>chan</i>', c2: 'mc-alerts' });

		expect(text).toContain('&lt;b&gt;Survival&lt;/b&gt;');
		expect(text).toContain('#&lt;i&gt;chan&lt;/i&gt;');
		expect(text).not.toContain('Theirs');
		expect(text).not.toMatch(/<b>|<i>/);
	});
});

describe('adding a Minecraft server', () => {
	const owner = () =>
		fakeGuild('g1', 'Shrimp Hall', { u1: false }, { c1: 'mc-chat', c2: '<i>alerts</i>' }, { ownerId: 'u1' });

	function addApp(pairing: BridgePairing | null = fakePairing()) {
		return createApp({ auth, client: fakeClient([owner()]), now: () => NOW, ...(pairing && { pairing }) });
	}

	const form = (fields: Record<string, string>) => ({
		method: 'POST',
		headers: { ...signedIn(), origin: auth.origin, 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString(),
	});
	const filled = { serverName: '  Survival  ', chat: 'c1', alerts: 'c2' };

	function pairTenBridges() {
		for (let i = 0; i < 10; i += 1) {
			createBridge({
				guildId: 'g1',
				chat: { channelId: 'c1', webhookId: `w${i}`, token: 't' },
				alerts: { channelId: 'c2', webhookId: `x${i}`, token: 't' },
				keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
				serverName: `S${i}`,
				now: NOW + i,
			});
		}
	}

	it("links the form from the Minecraft page, until the server's limit", async () => {
		const app = addApp();
		const link = '<a href="/servers/g1/minecraft/new">Add a Minecraft server</a>';

		expect(await (await app.request('/servers/g1/minecraft', { headers: signedIn() })).text()).toContain(link);
		pairTenBridges();
		expect(await (await app.request('/servers/g1/minecraft', { headers: signedIn() })).text()).not.toContain(link);
	});

	it('offers the channels pairing would accept from the member, asked of Discord for them', async () => {
		const pairing = fakePairing({
			choices: [
				{ id: 'c1', name: 'mc-chat' },
				{ id: 'c2', name: '<i>alerts</i>' },
			],
		});

		const response = await addApp(pairing).request('/servers/g1/minecraft/new', { headers: signedIn() });
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(pairing.channelChoices).toHaveBeenCalledWith('g1', 'u1');
		expect(text).toContain('<form method="post" action="/servers/g1/minecraft/new">');
		expect(text).toContain('<option value="c1" >#mc-chat</option>');
		expect(text).toContain('#&lt;i&gt;alerts&lt;/i&gt;');
		expect(text).not.toContain('<i>');
	});

	it('says why there is nothing to pick when the member can manage no channel', async () => {
		const text = await (
			await addApp(fakePairing({ choices: [] })).request('/servers/g1/minecraft/new', { headers: signedIn() })
		).text();

		expect(text).toContain("There's no channel to pick");
		expect(text).not.toContain('<form');
	});

	it('answers 404 when the member is gone by the time the form asks Discord', async () => {
		const response = await addApp(fakePairing({ choices: null })).request('/servers/g1/minecraft/new', {
			headers: signedIn(),
		});

		expect(response.status).toBe(404);
	});

	it('says the server is at its limit instead of offering the form', async () => {
		pairTenBridges();
		const pairing = fakePairing();

		const text = await (await addApp(pairing).request('/servers/g1/minecraft/new', { headers: signedIn() })).text();

		expect(text).toContain('already has 10 Minecraft servers paired');
		expect(text).not.toContain('<form');
		expect(pairing.channelChoices).not.toHaveBeenCalled();
	});

	it('answers 503 without pairing', async () => {
		const app = addApp(null);

		expect((await app.request('/servers/g1/minecraft/new', { headers: signedIn() })).status).toBe(503);
		expect((await app.request('/servers/g1/minecraft/new', form(filled))).status).toBe(503);
	});

	it('pairs with the trimmed name, the channels and the public origin, and shows the config once', async () => {
		const pairing = fakePairing();
		const app = addApp(pairing);

		const response = await app.request('/servers/g1/minecraft/new', form(filled));
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(pairing.pair).toHaveBeenCalledWith({
			guildId: 'g1',
			userId: 'u1',
			chatChannelId: 'c1',
			alertsChannelId: 'c2',
			serverName: 'Survival',
			dashboardUrl: auth.origin,
		});
		expect(text).toContain('<h1>Shrimp Hall: Survival paired</h1>');
		expect(text).toContain('shown only this once');
		expect(text).toContain('&quot;secret&quot;: &quot;the-secret&quot;');
		expect(text).toContain('&quot;url&quot;: &quot;https://dash.example/minecraft/&quot;');
		expect(text).toContain('<textarea readonly');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await (await app.request('/servers/g1/minecraft', { headers: signedIn() })).text()).toContain(
			'<h2>Survival</h2>',
		);
	});

	it('refuses a form from another site', async () => {
		const pairing = fakePairing();
		const request = form(filled);

		const response = await addApp(pairing).request('/servers/g1/minecraft/new', {
			...request,
			headers: { ...request.headers, origin: 'https://evil.example' },
		});

		expect(response.status).toBe(403);
		expect(pairing.pair).not.toHaveBeenCalled();
	});

	it('asks for both channels before pairing, keeping what was sent', async () => {
		const pairing = fakePairing();

		const response = await addApp(pairing).request(
			'/servers/g1/minecraft/new',
			form({ serverName: 'Survival', chat: 'c1' }),
		);
		const text = await response.text();

		expect(response.status).toBe(400);
		expect(pairing.pair).not.toHaveBeenCalled();
		expect(text).toContain('Pick a chat channel and an alerts channel.');
		expect(text).toContain('value="Survival"');
		expect(text).toContain('<option value="c1" selected>#general</option>');
	});

	it.each([
		[{ reason: 'bad-name', problem: 'x' }, 400, 'The name must be 1 to 80 characters'],
		[{ reason: 'unusable-channel', channelId: 'c9' }, 400, "the channel with ID c9 can't be used"],
		[
			{ reason: 'member-cant-manage-channel', channelId: 'c1' },
			400,
			'You need View Channel and Manage Webhooks in #mc-chat',
		],
		[
			{ reason: 'bot-missing-permissions', channelId: 'c2', missing: ['ManageWebhooks', 'ReadMessageHistory'] },
			400,
			'The bot needs Manage Webhooks, Read Message History in\n',
		],
		[{ reason: 'webhook-limit', channelId: 'c1', scope: 'channel' }, 400, '#mc-chat already has 15 webhooks'],
		[{ reason: 'webhook-limit', channelId: 'c1', scope: 'server' }, 400, 'already has 1000 webhooks'],
		[{ reason: 'error' }, 502, 'nothing was paired'],
	] as const)('says what to fix when pairing refuses (%o)', async (refusal, status, words) => {
		const response = await addApp(fakePairing({ answer: { ok: false, ...refusal } as PairAnswer })).request(
			'/servers/g1/minecraft/new',
			form(filled),
		);
		const text = await response.text();

		expect(response.status).toBe(status);
		expect(text).toContain('<p role="alert">');
		expect(text).toContain(words.trimEnd());
		expect(text).toContain('<form');
		expect(text).not.toContain('<i>');
	});

	it('names a channel by its escaped name in a refusal', async () => {
		const answer: PairAnswer = {
			ok: false,
			reason: 'bot-missing-permissions',
			channelId: 'c2',
			missing: ['ViewChannel'],
		};

		const text = await (
			await addApp(fakePairing({ answer })).request('/servers/g1/minecraft/new', form(filled))
		).text();

		expect(text).toContain('#&lt;i&gt;alerts&lt;/i&gt;');
	});

	it('answers 404 when the fresh check finds the member may no longer manage bridges', async () => {
		const response = await addApp(fakePairing({ answer: { ok: false, reason: 'not-allowed' } })).request(
			'/servers/g1/minecraft/new',
			form(filled),
		);

		expect(response.status).toBe(404);
	});

	it('shows the limit when pairing finds the server full', async () => {
		const response = await addApp(fakePairing({ answer: { ok: false, reason: 'bridge-limit', max: 10 } })).request(
			'/servers/g1/minecraft/new',
			form(filled),
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('already has 10 Minecraft servers paired');
	});
});

// Decision 0009: deny by default. A route missing from ROUTE_ACCESS, or one
// listed but not served, fails here, and every route behind a login is tried
// signed out and, for a server's routes, as a manager of another server. The
// Minecraft helper's routes have no login: they're tried without a seal.
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

	// A POST as the dashboard's own form sends it, so the CSRF check lets it
	// through and the guard is what answers.
	const send = (method: string, headers: Record<string, string> = {}): RequestInit =>
		method === 'GET'
			? { method, headers }
			: {
					method,
					headers: { ...headers, origin: auth.origin, 'content-type': 'application/x-www-form-urlencoded' },
					body: 'serverName=Survival&chat=c1&alerts=c1',
				};

	it("keeps every helper route under /minecraft/, where the pages' rate limit gives way to its own", () => {
		for (const [route, access] of declared) {
			if (access === 'helper') expect(route).toMatch(/^POST \/minecraft\/[a-z]+$/);
		}
	});

	it.each(declared.filter(([, access]) => access === 'signed-in' || access === 'server').map(([route]) => route))(
		'sends a signed-out visitor of %s back to the home page',
		async (route) => {
			const { method, path } = withGuild(route);

			const response = await app.request(path, send(method));

			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toBe('/');
		},
	);

	it.each(declared.filter(([, access]) => access === 'helper').map(([route]) => route))(
		'refuses %s without a sealed body, even from a signed-in visitor',
		async (route) => {
			const { method, path } = withGuild(route);

			const response = await app.request(path, {
				method,
				headers: { ...signedIn('u2'), 'content-type': 'application/json' },
				body: '{}',
			});

			expect(response.status).toBe(400);
		},
	);

	it.each(declared.filter(([, access]) => access === 'server').map(([route]) => route))(
		'answers 404 for %s to a user who manages only another server',
		async (route) => {
			const { method, path } = withGuild(route);

			const response = await app.request(path, send(method, signedIn('u1')));

			expect(response.status).toBe(404);
		},
	);

	it('keeps every bridges route under /servers/:guildId, where the guard runs', () => {
		for (const [route, access] of declared) {
			if (access === 'bridges') expect(route.split(' ')[1]).toMatch(/^\/servers\/:guildId\//);
		}
	});

	it.each(declared.filter(([, access]) => access === 'bridges').map(([route]) => route))(
		'sends a signed-out visitor of %s back to the home page, and answers 404 to a manager of another server',
		async (route) => {
			const { method, path } = withGuild(route);

			const signedOut = await app.request(path, send(method));
			const other = await app.request(path, send(method, signedIn('u1')));

			expect(signedOut.status).toBe(302);
			expect(signedOut.headers.get('location')).toBe('/');
			expect(other.status).toBe(404);
		},
	);

	// Decision 0013: requireServer lets in either right, so each route must
	// check its own. u-server has Manage Server only, u-bridges the allowed
	// role only; each is refused the other's routes with the same 404, and
	// u-none, a member with neither, is refused them all.
	describe('by right', () => {
		const rightsApp = createApp({
			auth,
			client: fakeClient([
				fakeGuild(
					'g1',
					'Shrimp Hall',
					{ 'u-server': true, 'u-bridges': false, 'u-none': false },
					{},
					{ roles: { 'u-bridges': ['r-mc'] } },
				),
			]),
			pairing: fakePairing(),
			now: () => NOW,
		});
		const levels = { server: 'u-server', bridges: 'u-bridges' } as const;
		const guarded = declared.filter(
			(entry): entry is [string, keyof typeof levels] => entry[1] === 'server' || entry[1] === 'bridges',
		);

		it.each(guarded)('answers %s only to a user with its right (%s)', async (route, level) => {
			setAllowedRole('g1', 'r-mc');
			const { method, path } = withGuild(route);
			const otherLevel = level === 'server' ? 'bridges' : 'server';

			const theirs = await rightsApp.request(path, send(method, signedIn(levels[level])));
			const others = await rightsApp.request(path, send(method, signedIn(levels[otherLevel])));

			const none = await rightsApp.request(path, send(method, signedIn('u-none')));

			expect(theirs.status).toBe(200);
			expect(others.status).toBe(404);
			expect(await others.text()).toContain('<h1>Not found</h1>');
			expect(none.status).toBe(404);
		});
	});
});
