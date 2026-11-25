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
import {
	MAX_PICTURES_PER_BRIDGE,
	createBridge,
	getBridge,
	getMinecraftGuildSettings,
	getPlayerPictures,
	markBridgeAnnounced,
	setAllowedRole,
	setPlayerPicture,
	updateBridgeSettings,
} from '../../src/minecraft/storage.ts';
import { fakeClient, fakeGuild } from './fakeGuilds.ts';
import { fakePairing } from './fakePairing.ts';
import type { BridgePairing, PairAnswer } from '../../src/minecraft/dashboardPairing.ts';
import { HelperHub, LEASE_MS, MAX_HELD_MESSAGES } from '../../src/minecraft/helperHub.ts';

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
	// What the member may pick; the bot's cache names the same channels.
	const both = [
		{ id: 'c1', name: 'mc-chat' },
		{ id: 'c2', name: '<i>alerts</i>' },
	];

	function addApp(pairing: BridgePairing | null = fakePairing({ choices: both })) {
		return createApp({ auth, client: fakeClient([owner()]), now: () => NOW, ...(pairing && { pairing }) });
	}

	const form = (fields: Record<string, string>) => ({
		method: 'POST',
		headers: { ...signedIn(), origin: auth.origin, 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString(),
	});
	const filled = { serverName: '  Survival  ', chat: 'c1', alerts: 'c2' };

	async function formToken(app: ReturnType<typeof addApp>, userId = 'u1'): Promise<string> {
		const text = await (await app.request('/servers/g1/minecraft/new', { headers: signedIn(userId) })).text();
		const token = /name="form" value="([^"]+)"/.exec(text)?.[1];
		if (!token) throw new Error('the form has no token');
		return token;
	}

	/** Loads the form, as a browser would, then sends it with its token. */
	async function submit(app: ReturnType<typeof addApp>, fields: Record<string, string>) {
		return app.request('/servers/g1/minecraft/new', form({ ...fields, form: await formToken(app) }));
	}

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
		const pairing = fakePairing({ choices: both });

		const response = await addApp(pairing).request('/servers/g1/minecraft/new', { headers: signedIn() });
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(pairing.channelChoices).toHaveBeenCalledWith('g1', 'u1');
		expect(text).toContain('<form method="post" action="/servers/g1/minecraft/new">');
		expect(text).toMatch(/<input type="hidden" name="form" value="[\w-]{22}" \/>/);
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

		const response = await submit(app, filled);
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

	it('pairs once for a form sent twice, as by a reload or a double click', async () => {
		const pairing = fakePairing();
		const app = addApp(pairing);
		const request = form({ ...filled, form: await formToken(app) });

		const [first, second] = await Promise.all([
			app.request('/servers/g1/minecraft/new', request),
			app.request('/servers/g1/minecraft/new', request),
		]);
		const statuses = [first.status, second.status].sort();

		expect(statuses).toEqual([200, 409]);
		expect(pairing.pair).toHaveBeenCalledTimes(1);
		const refused = first.status === 409 ? first : second;
		expect(await refused.text()).toContain('That form was already sent, or has expired.');
	});

	it("refuses a form without a token, or with one issued to someone else's form", async () => {
		const pairing = fakePairing();
		const app = createApp({
			auth,
			client: fakeClient([fakeGuild('g1', 'Shrimp Hall', { u1: false, u2: false }, {}, { ownerId: 'u1' })]),
			pairing,
			now: () => NOW,
		});
		setAllowedRole('g1', 'r-mc');

		const none = await app.request('/servers/g1/minecraft/new', form(filled));
		const forged = await app.request('/servers/g1/minecraft/new', form({ ...filled, form: 'made-up' }));

		expect(none.status).toBe(409);
		expect(forged.status).toBe(409);
		expect(pairing.pair).not.toHaveBeenCalled();
	});

	it("refuses another member's token", async () => {
		const pairing = fakePairing();
		const app = createApp({
			auth,
			client: fakeClient([
				fakeGuild('g1', 'Shrimp Hall', { u1: false, u2: false }, {}, { ownerId: 'u1', roles: { u2: ['r-mc'] } }),
			]),
			pairing,
			now: () => NOW,
		});
		setAllowedRole('g1', 'r-mc');
		const theirs = await formToken(app, 'u2');

		const response = await app.request('/servers/g1/minecraft/new', form({ ...filled, form: theirs }));

		expect(response.status).toBe(409);
		expect(pairing.pair).not.toHaveBeenCalled();
	});

	it('refuses a form from another site', async () => {
		const pairing = fakePairing();
		const app = addApp(pairing);
		const request = form({ ...filled, form: await formToken(app) });

		const response = await app.request('/servers/g1/minecraft/new', {
			...request,
			headers: { ...request.headers, origin: 'https://evil.example' },
		});

		expect(response.status).toBe(403);
		expect(pairing.pair).not.toHaveBeenCalled();
	});

	it('refuses a body far larger than the form', async () => {
		const pairing = fakePairing();
		const app = addApp(pairing);

		const response = await submit(app, { ...filled, serverName: 'x'.repeat(10_000) });

		expect(response.status).toBe(413);
		expect(pairing.pair).not.toHaveBeenCalled();
	});

	it('asks for both channels before pairing, keeping what was sent, with a new token', async () => {
		const pairing = fakePairing({ choices: both });
		const app = addApp(pairing);

		const response = await submit(app, { serverName: 'Survival', chat: 'c1' });
		const text = await response.text();

		expect(response.status).toBe(400);
		expect(pairing.pair).not.toHaveBeenCalled();
		expect(text).toContain('Pick a chat channel and an alerts channel.');
		expect(text).toContain('value="Survival"');
		expect(text).toContain('<option value="c1" selected>#mc-chat</option>');

		const token = /name="form" value="([^"]+)"/.exec(text)?.[1] ?? '';
		const retry = await app.request('/servers/g1/minecraft/new', form({ ...filled, form: token }));
		expect(retry.status).toBe(200);
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
			'The bot needs Manage Webhooks, Read Message History',
		],
		[{ reason: 'webhook-limit', channelId: 'c1', scope: 'channel' }, 400, '#mc-chat already has 15 webhooks'],
		[{ reason: 'webhook-limit', channelId: 'c1', scope: 'server' }, 400, 'already has 1000 webhooks'],
		[{ reason: 'error' }, 502, 'nothing was paired'],
		[{ reason: 'unknown-bridge' }, 502, 'nothing was paired'],
		[{ reason: 'bridge-changed' }, 502, 'nothing was paired'],
	] as const)('says what to fix when pairing refuses (%o)', async (refusal, status, words) => {
		const app = addApp(fakePairing({ choices: both, answer: { ok: false, ...refusal } as PairAnswer }));

		const response = await submit(app, filled);
		const text = await response.text();

		expect(response.status).toBe(status);
		expect(text).toContain('<p role="alert">');
		expect(text).toContain(words);
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

		const text = await (await submit(addApp(fakePairing({ choices: both, answer })), filled)).text();

		expect(text).toContain('#&lt;i&gt;alerts&lt;/i&gt;');
	});

	// Pairing refuses some channels before checking the member can see them,
	// so a refusal naming one from the bot's cache would tell them its name.
	it("names a channel the member can't pick only by the id they sent", async () => {
		const answer: PairAnswer = { ok: false, reason: 'member-cant-manage-channel', channelId: 'c2' };
		const pairing = fakePairing({ choices: [{ id: 'c1', name: 'mc-chat' }], answer });

		const text = await (await submit(addApp(pairing), filled)).text();

		expect(text).toContain('You need View Channel and Manage Webhooks in the channel with ID c2.');
		expect(text).not.toContain('&lt;i&gt;alerts&lt;/i&gt;');
	});

	it('answers 404 when the fresh check finds the member may no longer manage bridges', async () => {
		const app = addApp(fakePairing({ answer: { ok: false, reason: 'not-allowed' } }));

		expect((await submit(app, filled)).status).toBe(404);
	});

	it('shows the limit when pairing finds the server full', async () => {
		const response = await submit(
			addApp(fakePairing({ answer: { ok: false, reason: 'bridge-limit', max: 10 } })),
			filled,
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('already has 10 Minecraft servers paired');
	});
});

describe("regenerating and removing a Minecraft server's config", () => {
	// u1 owns g1; the bot's cache names its channels.
	const guilds = () => [
		fakeGuild('g1', 'Shrimp Hall', { u1: false }, { c1: 'mc-chat', c2: '<i>alerts</i>' }, { ownerId: 'u1' }),
		fakeGuild('g2', 'Other Place', { u1: false }, {}, { ownerId: 'u1' }),
	];
	let hub: HelperHub;

	beforeEach(() => {
		hub = new HelperHub(() => NOW);
	});

	function bridgeApp(pairing: BridgePairing | null = fakePairing()) {
		return createApp({ auth, client: fakeClient(guilds()), now: () => NOW, helpers: hub, ...(pairing && { pairing }) });
	}

	function pairedBridge(guildId = 'g1', serverName = 'Survival') {
		return createBridge({
			guildId,
			chat: { channelId: 'c1', webhookId: '901', token: 'tok-chat' },
			alerts: { channelId: 'c2', webhookId: '902', token: 'tok-alerts' },
			keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
			serverName,
			now: NOW,
		});
	}

	const post = (fields: Record<string, string> = {}, origin = auth.origin) => ({
		method: 'POST',
		headers: { ...signedIn(), origin, 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString(),
	});
	const regeneratePath = (bridgeId: string, guildId = 'g1') =>
		`/servers/${guildId}/minecraft/bridges/${bridgeId}/regenerate`;
	const removePath = (bridgeId: string, guildId = 'g1') => `/servers/${guildId}/minecraft/bridges/${bridgeId}/remove`;

	async function regenerateToken(app: ReturnType<typeof bridgeApp>, bridgeId: string): Promise<string> {
		const text = await (await app.request(regeneratePath(bridgeId), { headers: signedIn() })).text();
		const token = /name="form" value="([^"]+)"/.exec(text)?.[1];
		if (!token) throw new Error('the form has no token');
		return token;
	}

	it('links each bridge’s regenerate and remove pages from the Minecraft page', async () => {
		const bridge = pairedBridge();

		const text = await (await bridgeApp().request('/servers/g1/minecraft', { headers: signedIn() })).text();

		expect(text).toContain(`<a href="${regeneratePath(bridge.id)}">Regenerate its config</a>`);
		expect(text).toContain(`<a href="${removePath(bridge.id)}">Remove it</a>`);
	});

	it('answers 404 for an unknown bridge and for another server’s, though the user manages both', async () => {
		const theirs = pairedBridge('g2');
		const pairing = fakePairing();
		const app = bridgeApp(pairing);

		for (const path of [regeneratePath('nope'), regeneratePath(theirs.id), removePath('nope'), removePath(theirs.id)]) {
			expect((await app.request(path, { headers: signedIn() })).status).toBe(404);
			expect((await app.request(path, post())).status).toBe(404);
		}
		expect(pairing.regenerate).not.toHaveBeenCalled();
		expect(pairing.remove).not.toHaveBeenCalled();
	});

	it('answers 503 without pairing', async () => {
		const bridge = pairedBridge();
		const app = bridgeApp(null);

		for (const path of [regeneratePath(bridge.id), removePath(bridge.id)]) {
			expect((await app.request(path, { headers: signedIn() })).status).toBe(503);
			expect((await app.request(path, post())).status).toBe(503);
		}
	});

	describe('regenerating', () => {
		it('asks first, saying the helper stops until the new config is in place', async () => {
			const bridge = pairedBridge('g1', '<b>Survival</b>');

			const text = await (await bridgeApp().request(regeneratePath(bridge.id), { headers: signedIn() })).text();

			expect(text).toContain('<h1>Shrimp Hall: regenerate &lt;b&gt;Survival&lt;/b&gt;&#39;s config</h1>');
			expect(text).toContain('stops posting in Discord and reaching the bot');
			expect(text).toContain(`<form method="post" action="${regeneratePath(bridge.id)}">`);
		});

		it('regenerates as the member with the public origin, shows the new config once, and ends the old helper’s poll', async () => {
			const bridge = pairedBridge();
			const pairing = fakePairing();
			const app = bridgeApp(pairing);
			const held = hub.poll(bridge.id, hub.connect(bridge.id));

			const response = await app.request(
				regeneratePath(bridge.id),
				post({ form: await regenerateToken(app, bridge.id) }),
			);
			const text = await response.text();

			expect(response.status).toBe(200);
			expect(pairing.regenerate).toHaveBeenCalledWith({
				guildId: 'g1',
				userId: 'u1',
				bridgeId: bridge.id,
				dashboardUrl: auth.origin,
			});
			expect(text).toContain('<h1>Shrimp Hall: Survival&#39;s config regenerated</h1>');
			expect(text).toContain('shown only this once');
			expect(text).toContain('&quot;secret&quot;: &quot;the-new-secret&quot;');
			expect(text).not.toContain('role="alert"');
			expect(response.headers.get('cache-control')).toBe('no-store');
			await expect(held).resolves.toEqual({ kind: 'session-ended' });
		});

		it('names an old webhook Discord kept, as it still posts', async () => {
			const bridge = pairedBridge();
			const app = bridgeApp(fakePairing({ undeleted: [{ channelId: 'c2', webhookId: '902' }] }));

			const response = await app.request(
				regeneratePath(bridge.id),
				post({ form: await regenerateToken(app, bridge.id) }),
			);

			expect(await response.text()).toMatch(/can still post through it[\s\S]*ID 902 in #&lt;i&gt;alerts&lt;\/i&gt;/);
		});

		it('regenerates once for a form sent twice, as by a reload or a double click', async () => {
			const bridge = pairedBridge();
			const pairing = fakePairing();
			const app = bridgeApp(pairing);
			const request = post({ form: await regenerateToken(app, bridge.id) });

			const [first, second] = await Promise.all([
				app.request(regeneratePath(bridge.id), request),
				app.request(regeneratePath(bridge.id), request),
			]);

			expect([first.status, second.status].sort()).toEqual([200, 409]);
			expect(pairing.regenerate).toHaveBeenCalledTimes(1);
			const refused = first.status === 409 ? first : second;
			expect(await refused.text()).toContain('That form was already sent, or has expired.');
		});

		it("refuses a form without a token, or with one for another bridge's form", async () => {
			const bridge = pairedBridge();
			const other = pairedBridge('g1', 'Creative');
			const pairing = fakePairing();
			const app = bridgeApp(pairing);

			expect((await app.request(regeneratePath(bridge.id), post())).status).toBe(409);
			const token = await regenerateToken(app, other.id);
			expect((await app.request(regeneratePath(bridge.id), post({ form: token }))).status).toBe(409);
			expect(pairing.regenerate).not.toHaveBeenCalled();
		});

		it('says what to fix, naming the channel escaped, with a new token, and leaves the helper connected', async () => {
			const bridge = pairedBridge();
			const app = bridgeApp(
				fakePairing({ regenerateAnswer: { ok: false, reason: 'member-cant-manage-channel', channelId: 'c2' } }),
			);
			const session = hub.connect(bridge.id);
			const first = await regenerateToken(app, bridge.id);

			const response = await app.request(regeneratePath(bridge.id), post({ form: first }));
			const text = await response.text();

			expect(response.status).toBe(400);
			expect(text).toContain('You need View Channel and Manage Webhooks in #&lt;i&gt;alerts&lt;/i&gt;.');
			const again = /name="form" value="([^"]+)"/.exec(text)?.[1];
			expect(again).toBeDefined();
			expect(again).not.toBe(first);
			hub.deliver(bridge.id, 'still connected');
			await expect(hub.poll(bridge.id, session)).resolves.toEqual({ kind: 'messages', messages: ['still connected'] });
		});

		it('says a channel that is gone means pairing again, and that a failure kept the old config', async () => {
			const bridge = pairedBridge();
			const gone = bridgeApp(
				fakePairing({ regenerateAnswer: { ok: false, reason: 'unusable-channel', channelId: 'c9' } }),
			);
			const failed = bridgeApp(fakePairing({ regenerateAnswer: { ok: false, reason: 'error' } }));

			const goneResponse = await gone.request(
				regeneratePath(bridge.id),
				post({ form: await regenerateToken(gone, bridge.id) }),
			);
			const failedResponse = await failed.request(
				regeneratePath(bridge.id),
				post({ form: await regenerateToken(failed, bridge.id) }),
			);

			expect(goneResponse.status).toBe(400);
			expect(await goneResponse.text()).toContain('the channel with ID c9 is gone');
			expect(failedResponse.status).toBe(502);
			expect(await failedResponse.text()).toContain('the old config still works');
		});

		it('answers 404 when the fresh check finds the member may no longer manage bridges', async () => {
			const bridge = pairedBridge();
			const app = bridgeApp(fakePairing({ regenerateAnswer: { ok: false, reason: 'not-allowed' } }));

			const response = await app.request(
				regeneratePath(bridge.id),
				post({ form: await regenerateToken(app, bridge.id) }),
			);

			expect(response.status).toBe(404);
		});
	});

	describe('removing', () => {
		it('asks first, saying what goes with it', async () => {
			const bridge = pairedBridge();

			const text = await (await bridgeApp().request(removePath(bridge.id), { headers: signedIn() })).text();

			expect(text).toContain('<h1>Shrimp Hall: remove Survival</h1>');
			expect(text).toContain("This can't be undone");
			expect(text).toContain(`<form method="post" action="${removePath(bridge.id)}">`);
		});

		it('removes as the member, ends the helper’s poll, and goes back to the list without it', async () => {
			const bridge = pairedBridge();
			const pairing = fakePairing();
			const app = bridgeApp(pairing);
			const held = hub.poll(bridge.id, hub.connect(bridge.id));

			const response = await app.request(removePath(bridge.id), post());

			expect(response.status).toBe(303);
			expect(response.headers.get('location')).toBe('/servers/g1/minecraft');
			expect(pairing.remove).toHaveBeenCalledWith({ guildId: 'g1', userId: 'u1', bridgeId: bridge.id });
			await expect(held).resolves.toEqual({ kind: 'session-ended' });
			const list = await (await app.request('/servers/g1/minecraft', { headers: signedIn() })).text();
			expect(list).toContain('No Minecraft servers paired yet.');
		});

		it('names a webhook Discord kept instead of going back to the list', async () => {
			const bridge = pairedBridge();
			const app = bridgeApp(fakePairing({ undeleted: [{ channelId: 'c1', webhookId: '901' }] }));

			const response = await app.request(removePath(bridge.id), post());
			const text = await response.text();

			expect(response.status).toBe(200);
			expect(text).toContain('<h1>Shrimp Hall: Survival removed</h1>');
			expect(text).toContain('ID 901 in #mc-chat');
		});

		it('says nothing was removed when the bot failed, and answers 404 when the member may no longer', async () => {
			const bridge = pairedBridge();
			const failed = await bridgeApp(fakePairing({ removeAnswer: { ok: false, reason: 'error' } })).request(
				removePath(bridge.id),
				post(),
			);
			const refused = await bridgeApp(fakePairing({ removeAnswer: { ok: false, reason: 'not-allowed' } })).request(
				removePath(bridge.id),
				post(),
			);

			expect(failed.status).toBe(502);
			expect(await failed.text()).toContain('nothing was removed');
			expect(refused.status).toBe(404);
		});

		it('refuses a form from another site', async () => {
			const bridge = pairedBridge();
			const pairing = fakePairing();

			const response = await bridgeApp(pairing).request(removePath(bridge.id), post({}, 'https://evil.example'));

			expect(response.status).toBe(403);
			expect(pairing.remove).not.toHaveBeenCalled();
		});
	});
});

describe("a Minecraft server's settings", () => {
	// u1 owns g1 and g2; u2 has the allowed role in g1.
	const members: Record<string, boolean | 'timed out'> = {};
	let hub: HelperHub;

	beforeEach(() => {
		hub = new HelperHub(() => NOW);
		for (const key of Object.keys(members)) delete members[key];
		Object.assign(members, { u1: false, u2: false });
		setAllowedRole('g1', 'r-mc');
	});

	function settingsApp() {
		return createApp({
			auth,
			client: fakeClient([
				fakeGuild('g1', 'Shrimp Hall', members, {}, { ownerId: 'u1', roles: { u2: ['r-mc'] } }),
				fakeGuild('g2', 'Other Place', { u1: false }, {}, { ownerId: 'u1' }),
			]),
			now: () => NOW,
			helpers: hub,
		});
	}

	function pairedBridge(guildId = 'g1', serverName = 'Survival') {
		return createBridge({
			guildId,
			chat: { channelId: 'c1', webhookId: '901', token: 'tok-chat' },
			alerts: { channelId: 'c2', webhookId: '902', token: 'tok-alerts' },
			keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
			serverName,
			now: NOW,
		});
	}

	const settingsPath = (bridgeId: string, guildId = 'g1') => `/servers/${guildId}/minecraft/bridges/${bridgeId}`;
	const filled = { serverName: 'Creative', prefix: '[DC]', colour: 'gold', defaultPicture: 'skin' };
	const save = (fields: Record<string, string> = filled, userId = 'u1', origin = auth.origin) => ({
		method: 'POST',
		headers: { ...signedIn(userId), origin, 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString(),
	});

	it('links each bridge’s settings from the Minecraft page', async () => {
		const bridge = pairedBridge();

		const text = await (await settingsApp().request('/servers/g1/minecraft', { headers: signedIn() })).text();

		expect(text).toContain(`<a href="${settingsPath(bridge.id)}">Change its settings</a>`);
	});

	it('shows the saved settings in the form, escaped, with the config’s default picture chosen', async () => {
		const bridge = pairedBridge('g1', '<b>Survival</b>');

		const response = await settingsApp().request(settingsPath(bridge.id), { headers: signedIn('u2') });
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).toContain('<h1>Shrimp Hall: &lt;b&gt;Survival&lt;/b&gt;&#39;s settings</h1>');
		expect(text).toContain('name="serverName" required maxlength="80" value="&lt;b&gt;Survival&lt;/b&gt;"');
		expect(text).toContain('value="[Discord]"');
		expect(text).toContain('value="#5865F2"');
		expect(text).toMatch(/<option value="" selected>As the helper/);
		expect(text).not.toContain('<b>');
	});

	it('shows a default picture set before as chosen', async () => {
		const bridge = pairedBridge();
		updateBridgeSettings(bridge.id, { defaultPicture: 'none' });

		const text = await (await settingsApp().request(settingsPath(bridge.id), { headers: signedIn() })).text();

		expect(text).toMatch(/<option value="none" selected>/);
		expect(text).not.toMatch(/<option value="" selected>/);
	});

	it('answers 404 for an unknown bridge and for another server’s, though the user manages both', async () => {
		const theirs = pairedBridge('g2');
		const app = settingsApp();

		for (const path of [settingsPath('nope'), settingsPath(theirs.id)]) {
			expect((await app.request(path, { headers: signedIn() })).status).toBe(404);
			expect((await app.request(path, save())).status).toBe(404);
		}
		expect(getBridge(theirs.id)?.server_name).toBe('Survival');
	});

	it('saves the settings, trimmed, and goes back to the list', async () => {
		const bridge = pairedBridge();

		const response = await settingsApp().request(
			settingsPath(bridge.id),
			save({ serverName: ' Creative ', prefix: '[DC]', colour: '#00FF00', defaultPicture: '' }, 'u2'),
		);

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/servers/g1/minecraft');
		expect(getBridge(bridge.id)).toMatchObject({
			server_name: 'Creative',
			prefix: '[DC]',
			colour: '#00ff00',
			default_picture: null,
		});
	});

	it('sends the new settings to a connected helper at once', async () => {
		const bridge = pairedBridge();
		const session = hub.connect(bridge.id);
		const poll = hub.poll(bridge.id, session);

		await settingsApp().request(settingsPath(bridge.id), save());

		expect(await poll).toEqual({
			kind: 'messages',
			messages: [
				{
					kind: 'settings',
					serverName: 'Creative',
					prefix: '[DC]',
					colour: 'gold',
					defaultPicture: 'skin',
					pictures: [],
				},
			],
		});
	});

	it('says what to fix, keeping what was sent, and saves and sends nothing', async () => {
		const bridge = pairedBridge();
		const session = hub.connect(bridge.id);

		const response = await settingsApp().request(
			settingsPath(bridge.id),
			save({ serverName: 'Creative', prefix: '<b>', colour: 'pink', defaultPicture: 'skin' }),
		);
		const text = await response.text();

		expect(response.status).toBe(400);
		expect(text).toContain('Nothing was saved');
		expect(text).toContain('The prefix must be');
		expect(text).toContain('The colour must be');
		expect(text).not.toContain('The name must be');
		expect(text).toContain('value="&lt;b&gt;"');
		expect(text).toContain('value="pink"');
		expect(text).toMatch(/<option value="skin" selected>/);
		expect(getBridge(bridge.id)).toMatchObject({ server_name: 'Survival', prefix: '[Discord]' });
		hub.close();
		expect(await hub.poll(bridge.id, session)).toEqual({ kind: 'messages', messages: [] });
	});

	it('refuses a form missing a field, naming it, and sends nothing', async () => {
		const bridge = pairedBridge();
		const session = hub.connect(bridge.id);
		const withoutColour = { serverName: 'Creative', prefix: '[DC]', defaultPicture: 'skin' };

		const response = await settingsApp().request(settingsPath(bridge.id), save(withoutColour));
		const text = await response.text();

		expect(response.status).toBe(400);
		expect(text).toContain('The colour must be');
		expect(text).not.toContain('The prefix must be');
		expect(getBridge(bridge.id)?.server_name).toBe('Survival');
		hub.close();
		expect(await hub.poll(bridge.id, session)).toEqual({ kind: 'messages', messages: [] });
	});

	// A helper backing off after a failed poll keeps its session for up to
	// LEASE_MS, and wouldn't connect again to get them.
	it('holds the settings for a connected helper that polls only after chat would have been dropped', async () => {
		let time = NOW;
		hub = new HelperHub(() => time);
		const bridge = pairedBridge();
		const session = hub.connect(bridge.id);

		await settingsApp().request(settingsPath(bridge.id), save());
		time += LEASE_MS - 1000;

		expect(await hub.poll(bridge.id, session)).toMatchObject({
			kind: 'messages',
			messages: [{ kind: 'settings', serverName: 'Creative' }],
		});
	});

	it('logs settings saved but not queued when too many messages are waiting', async () => {
		const bridge = pairedBridge();
		for (let i = 0; i < MAX_HELD_MESSAGES; i++) hub.deliver(bridge.id, { kind: 'chat' });
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await settingsApp().request(settingsPath(bridge.id), save());

		expect(response.status).toBe(303);
		expect(getBridge(bridge.id)?.server_name).toBe('Creative');
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining(`bridge ${bridge.id}'s settings were saved but not queued`),
		);
	});

	it('asks Discord afresh before saving, so a member who lost the role is refused', async () => {
		const bridge = pairedBridge();
		const app = settingsApp();
		expect((await app.request(settingsPath(bridge.id), { headers: signedIn('u2') })).status).toBe(200);

		members['u2'] = 'timed out';
		const response = await app.request(settingsPath(bridge.id), save(filled, 'u2'));

		expect(response.status).toBe(404);
		expect(getBridge(bridge.id)?.server_name).toBe('Survival');
	});

	it('refuses a form from another site, and a body far larger than the form', async () => {
		const bridge = pairedBridge();
		const app = settingsApp();

		const crossSite = await app.request(settingsPath(bridge.id), save(filled, 'u1', 'https://evil.example'));
		const large = await app.request(settingsPath(bridge.id), save({ ...filled, serverName: 'x'.repeat(10_000) }));

		expect(crossSite.status).toBe(403);
		expect(large.status).toBe(413);
		expect(getBridge(bridge.id)?.server_name).toBe('Survival');
	});

	describe('pictures for players', () => {
		const picturesPath = (bridgeId: string, guildId = 'g1') => `${settingsPath(bridgeId, guildId)}/pictures`;
		const pictures = (bridgeId: string) => getPlayerPictures(bridgeId).map(({ name, picture }) => ({ name, picture }));

		it('says when none are set, and offers each picture the helper takes', async () => {
			const bridge = pairedBridge();

			const text = await (await settingsApp().request(settingsPath(bridge.id), { headers: signedIn() })).text();

			expect(text).toContain('<h2>Pictures for players</h2>');
			expect(text).toContain('<p>None yet.</p>');
			expect(text).toContain(`<form method="post" action="${picturesPath(bridge.id)}">`);
			for (const value of ['generated', 'generated:0', 'generated:9', 'skin', 'none']) {
				expect(text).toContain(`<option value="${value}"`);
			}
			expect(text).not.toContain('<option value="generated:10"');
			expect(text).not.toContain('<option value="discord"');
		});

		it('lists the pictures set, each with a button to remove it', async () => {
			const bridge = pairedBridge();
			setPlayerPicture(bridge.id, 'Steve', 'generated:3');
			setPlayerPicture(bridge.id, 'alex', 'skin');

			const text = await (await settingsApp().request(settingsPath(bridge.id), { headers: signedIn('u2') })).text();

			expect(text).toMatch(/<td>alex<\/td>\s*<td>Their skin&#39;s face/);
			expect(text).toMatch(/<td>Steve<\/td>\s*<td>Generated picture 4<\/td>/);
			expect(text).toContain('<input type="hidden" name="name" value="Steve" />');
			expect(text).toContain('<input type="hidden" name="picture" value="" />');
			expect(text).not.toContain('None yet.');
		});

		it('sets a picture, trimming the name, sends it to a connected helper, and goes back to the settings', async () => {
			const bridge = pairedBridge();
			const session = hub.connect(bridge.id);
			const poll = hub.poll(bridge.id, session);

			const response = await settingsApp().request(
				picturesPath(bridge.id),
				save({ name: ' Steve ', picture: 'generated:9' }, 'u2'),
			);

			expect(response.status).toBe(303);
			expect(response.headers.get('location')).toBe(settingsPath(bridge.id));
			expect(pictures(bridge.id)).toEqual([{ name: 'Steve', picture: 'generated:9' }]);
			expect(await poll).toEqual({
				kind: 'messages',
				messages: [
					{
						kind: 'settings',
						serverName: 'Survival',
						prefix: '[Discord]',
						colour: '#5865F2',
						defaultPicture: null,
						pictures: [{ name: 'Steve', picture: 'generated:9' }],
					},
				],
			});
		});

		it('changes a name’s picture whatever its case, and removes it with an empty picture, sending each', async () => {
			const bridge = pairedBridge();
			setPlayerPicture(bridge.id, 'Steve', 'skin');
			const session = hub.connect(bridge.id);
			const app = settingsApp();

			await app.request(picturesPath(bridge.id), save({ name: 'STEVE', picture: 'none' }));
			expect(pictures(bridge.id)).toEqual([{ name: 'STEVE', picture: 'none' }]);
			await app.request(picturesPath(bridge.id), save({ name: 'steve', picture: '' }));
			expect(pictures(bridge.id)).toEqual([]);

			expect(await hub.poll(bridge.id, session)).toMatchObject({
				messages: [
					{ kind: 'settings', pictures: [{ name: 'STEVE', picture: 'none' }] },
					{ kind: 'settings', pictures: [] },
				],
			});
		});

		it('says what to fix, keeping what was sent, and saves and sends nothing', async () => {
			const bridge = pairedBridge();
			const session = hub.connect(bridge.id);

			const response = await settingsApp().request(
				picturesPath(bridge.id),
				save({ name: '<b>Steve</b>', picture: 'https://example.com/a.png' }),
			);
			const text = await response.text();

			expect(response.status).toBe(400);
			expect(text).toContain("That picture wasn't saved");
			expect(text).toContain('A player’s name is 1 to 16 letters');
			expect(text).toContain('Pick a picture from the list.');
			expect(text).toContain('name="name" required maxlength="16" value="&lt;b&gt;Steve&lt;/b&gt;"');
			expect(text).not.toContain('<b>Steve');
			expect(text).not.toContain('Nothing was saved');
			expect(pictures(bridge.id)).toEqual([]);
			hub.close();
			expect(await hub.poll(bridge.id, session)).toEqual({ kind: 'messages', messages: [] });
		});

		it('keeps the picture chosen when only the name is refused', async () => {
			const bridge = pairedBridge();

			const response = await settingsApp().request(picturesPath(bridge.id), save({ name: 'Steve-2', picture: 'skin' }));
			const text = await response.text();

			expect(response.status).toBe(400);
			expect(text).toContain('A player’s name is 1 to 16 letters');
			expect(text).not.toContain('Pick a picture from the list.');
			expect(text).toMatch(/<option value="skin" selected>/);
		});

		it('refuses a new name once the bridge has the most, but still changes one it has', async () => {
			const bridge = pairedBridge();
			for (let i = 0; i < MAX_PICTURES_PER_BRIDGE; i++) setPlayerPicture(bridge.id, `player${i}`, 'skin');
			const app = settingsApp();

			const refused = await app.request(picturesPath(bridge.id), save({ name: 'Steve', picture: 'skin' }));
			const changed = await app.request(picturesPath(bridge.id), save({ name: 'player0', picture: 'none' }));

			expect(refused.status).toBe(400);
			expect(await refused.text()).toContain(
				`A Minecraft server can have pictures for at most ${MAX_PICTURES_PER_BRIDGE} players.`,
			);
			expect(changed.status).toBe(303);
			expect(getPlayerPictures(bridge.id)).toHaveLength(MAX_PICTURES_PER_BRIDGE);
			expect(getPlayerPictures(bridge.id).find((p) => p.name_key === 'player0')?.picture).toBe('none');
		});

		it('answers 404 for an unknown bridge and for another server’s, though the user manages both', async () => {
			const theirs = pairedBridge('g2');
			const app = settingsApp();

			for (const path of [picturesPath('nope'), picturesPath(theirs.id)]) {
				expect((await app.request(path, save({ name: 'Steve', picture: 'skin' }))).status).toBe(404);
			}
			expect(pictures(theirs.id)).toEqual([]);
		});

		it('asks Discord afresh before saving, so a member who lost the role is refused', async () => {
			const bridge = pairedBridge();
			members['u2'] = 'timed out';

			const response = await settingsApp().request(
				picturesPath(bridge.id),
				save({ name: 'Steve', picture: 'skin' }, 'u2'),
			);

			expect(response.status).toBe(404);
			expect(pictures(bridge.id)).toEqual([]);
		});

		it('refuses a form from another site, and a body far larger than the form', async () => {
			const bridge = pairedBridge();
			const app = settingsApp();

			const crossSite = await app.request(
				picturesPath(bridge.id),
				save({ name: 'Steve', picture: 'skin' }, 'u1', 'https://evil.example'),
			);
			const large = await app.request(picturesPath(bridge.id), save({ name: 'x'.repeat(2000), picture: 'skin' }));

			expect(crossSite.status).toBe(403);
			expect(large.status).toBe(413);
			expect(pictures(bridge.id)).toEqual([]);
		});
	});
});

describe('who may manage Minecraft servers', () => {
	// u1 owns g1; u2 has r-mc; r-bot is an integration's.
	const serverRoles = {
		'r-mods': 'Mods',
		'r-mc': '<b>Minecraft</b>',
		'r-bot': { name: 'Shrimp Bot', managed: true },
		g1: '@everyone',
	};

	function roleApp(members: Record<string, boolean | 'timed out'> = { u1: false, u2: false }) {
		return createApp({
			auth,
			client: fakeClient([
				fakeGuild('g1', 'Shrimp Hall', members, {}, { ownerId: 'u1', roles: { u2: ['r-mc'] }, serverRoles }),
			]),
			now: () => NOW,
		});
	}

	const save = (role: string, userId = 'u1') => ({
		method: 'POST',
		headers: { ...signedIn(userId), origin: auth.origin, 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ role }).toString(),
	});

	const minecraftPageOf = async (app: ReturnType<typeof roleApp>, userId = 'u1') =>
		(await app.request('/servers/g1/minecraft', { headers: signedIn(userId) })).text();

	it('says only the owner manages them while no role is allowed, and offers the owner the change', async () => {
		const text = await minecraftPageOf(roleApp());

		expect(text).toContain('Only the server&#39;s owner manages them.');
		expect(text).toContain('<a href="/servers/g1/minecraft/role">Change who may manage them</a>');
	});

	it('names the allowed role, escaped, and offers the change to the owner alone', async () => {
		setAllowedRole('g1', 'r-mc');
		const app = roleApp();

		const owners = await minecraftPageOf(app);
		const theirs = await minecraftPageOf(app, 'u2');

		expect(owners).toContain('and members with the role @&lt;b&gt;Minecraft&lt;/b&gt;.');
		expect(theirs).toContain('and members with the role @&lt;b&gt;Minecraft&lt;/b&gt;.');
		expect(theirs).not.toContain('/minecraft/role');
	});

	it('says so when the allowed role is no longer in the server', async () => {
		setAllowedRole('g1', 'r-gone');

		expect(await minecraftPageOf(roleApp())).toContain("a role that's no longer in the server (ID r-gone)");
	});

	it("offers the server's roles but @everyone and integrations', highest first, with the current one chosen", async () => {
		setAllowedRole('g1', 'r-mc');

		const response = await roleApp().request('/servers/g1/minecraft/role', { headers: signedIn() });
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).toMatch(/value="r-mods"[^>]*>\s*@Mods[\s\S]*value="r-mc" selected>\s*@&lt;b&gt;Minecraft/);
		expect(text).not.toContain('Shrimp Bot');
		expect(text).not.toContain('value="g1"');
		expect(text).not.toContain('<b>');
		expect(text).toContain('Anyone who can give members that role');
	});

	it('saves a role and goes back to the list, where its members may now manage', async () => {
		const app = roleApp();

		const response = await app.request('/servers/g1/minecraft/role', save('r-mc'));

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/servers/g1/minecraft');
		expect(getMinecraftGuildSettings('g1')?.allowed_role_id).toBe('r-mc');
		expect((await app.request('/servers/g1/minecraft', { headers: signedIn('u2') })).status).toBe(200);
	});

	it('clears the role, leaving bridges to the owner', async () => {
		setAllowedRole('g1', 'r-mc');

		const response = await roleApp().request('/servers/g1/minecraft/role', save(''));

		expect(response.status).toBe(303);
		expect(getMinecraftGuildSettings('g1')?.allowed_role_id).toBeNull();
	});

	it.each([
		['@everyone', 'g1'],
		["an integration's role", 'r-bot'],
		['a role not in the server', 'r-gone'],
	])('refuses %s, changing nothing', async (_what, role) => {
		setAllowedRole('g1', 'r-mods');

		const response = await roleApp().request('/servers/g1/minecraft/role', save(role));

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("That role can't be chosen.");
		expect(getMinecraftGuildSettings('g1')?.allowed_role_id).toBe('r-mods');
	});

	it('asks Discord afresh before saving, so a former owner is refused once the server changes hands', async () => {
		const guild = fakeGuild('g1', 'Shrimp Hall', { u1: false, u2: false }, {}, { ownerId: 'u1', serverRoles });
		const app = createApp({ auth, client: fakeClient([guild]), now: () => NOW });
		expect((await app.request('/servers/g1/minecraft/role', { headers: signedIn() })).status).toBe(200);

		guild.ownerId = 'u2';
		const response = await app.request('/servers/g1/minecraft/role', save('r-mc'));

		expect(response.status).toBe(404);
		expect(getMinecraftGuildSettings('g1')).toBeUndefined();
	});

	it('refuses an owner in timeout, asking Discord afresh', async () => {
		const members: Record<string, boolean | 'timed out'> = { u1: false };
		const app = roleApp(members);
		expect((await app.request('/servers/g1/minecraft/role', { headers: signedIn() })).status).toBe(200);

		members['u1'] = 'timed out';
		const response = await app.request('/servers/g1/minecraft/role', save('r-mc'));

		expect(response.status).toBe(404);
		expect(getMinecraftGuildSettings('g1')).toBeUndefined();
	});

	it('says when the role saved is no longer in the server, offering none chosen', async () => {
		setAllowedRole('g1', 'r-gone');

		const text = await (await roleApp().request('/servers/g1/minecraft/role', { headers: signedIn() })).text();

		expect(text).toContain('The role chosen before is no longer in the server (ID r-gone)');
		expect(text).not.toContain(' selected>');
	});

	it('refuses a form from another site', async () => {
		const request = save('r-mc');

		const response = await roleApp().request('/servers/g1/minecraft/role', {
			...request,
			headers: { ...request.headers, origin: 'https://evil.example' },
		});

		expect(response.status).toBe(403);
		expect(getMinecraftGuildSettings('g1')).toBeUndefined();
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

	// A bridge's routes look it up after the guard, so where the guard answers
	// any id will do; the tests that get past it pass a real one.
	const withGuild = (route: string, bridgeId = 'b1') => {
		const [method, path] = route.split(' ') as [string, string];
		return { method, path: path.replace(':guildId', 'g1').replace(':bridgeId', bridgeId) };
	};

	// A POST as the dashboard's own form sends it, so the CSRF check lets it
	// through and the guard is what answers.
	const send = (method: string, headers: Record<string, string> = {}, form = ''): RequestInit =>
		method === 'GET'
			? { method, headers }
			: {
					method,
					headers: { ...headers, origin: auth.origin, 'content-type': 'application/x-www-form-urlencoded' },
					body: `serverName=Survival&chat=c1&alerts=c1&prefix=%5BDC%5D&colour=gold&defaultPicture=&name=Steve&picture=skin&form=${form}`,
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
			if (access === 'bridges' || access === 'owner') expect(route.split(' ')[1]).toMatch(/^\/servers\/:guildId\//);
		}
	});

	it.each(declared.filter(([, access]) => access === 'bridges' || access === 'owner').map(([route]) => route))(
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
					{ 'u-server': true, 'u-bridges': false, 'u-none': false, 'u-owner': false },
					{},
					{ ownerId: 'u-owner', roles: { 'u-bridges': ['r-mc'] } },
				),
			]),
			pairing: fakePairing(),
			now: () => NOW,
		});
		const levels = { server: 'u-server', bridges: 'u-bridges', owner: 'u-owner' } as const;
		// Someone with a right, but not this one: owner routes are refused to a
		// bridge manager who isn't the owner.
		const other = { server: 'bridges', bridges: 'server', owner: 'bridges' } as const;
		// What a route answers when it's done: the role, settings and pictures forms save, then redirect.
		const success: Record<string, number> = {
			'POST /servers/:guildId/minecraft/role': 303,
			'POST /servers/:guildId/minecraft/bridges/:bridgeId': 303,
			'POST /servers/:guildId/minecraft/bridges/:bridgeId/pictures': 303,
			'POST /servers/:guildId/minecraft/bridges/:bridgeId/remove': 303,
		};
		const guarded = declared.filter((entry): entry is [string, keyof typeof levels] => entry[1] in levels);

		it.each(guarded)('answers %s only to a user with its right (%s)', async (route, level) => {
			setAllowedRole('g1', 'r-mc');
			const bridge = createBridge({
				guildId: 'g1',
				chat: { channelId: 'c1', webhookId: 'w1', token: 't' },
				alerts: { channelId: 'c1', webhookId: 'w2', token: 't' },
				keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
				serverName: 'Survival',
				now: NOW,
			});
			const { method, path } = withGuild(route, bridge.id);
			const otherLevel = other[level];

			// A form's POST carries the token its page gave this user (formTokens.ts).
			const page =
				method === 'GET' ? '' : await (await rightsApp.request(path, send('GET', signedIn(levels[level])))).text();
			const token = /name="form" value="([^"]+)"/.exec(page)?.[1] ?? '';
			const theirs = await rightsApp.request(path, send(method, signedIn(levels[level]), token));
			const others = await rightsApp.request(path, send(method, signedIn(levels[otherLevel])));

			const none = await rightsApp.request(path, send(method, signedIn('u-none')));

			expect(theirs.status).toBe(success[route] ?? 200);
			expect(others.status).toBe(404);
			expect(await others.text()).toContain('<h1>Not found</h1>');
			expect(none.status).toBe(404);
		});
	});
});
