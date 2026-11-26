import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_CODES_PER_WINDOW, LINK_CODE_WINDOW_MS, createApp } from '../../src/dashboard/app.ts';
import type { AuthConfig } from '../../src/dashboard/auth.ts';
import { startSession } from '../../src/dashboard/sessions.ts';
import { __resetForTests } from '../../src/core/database.ts';
import { LinkCodes } from '../../src/minecraft/linking.ts';
import { createBridge, getBridgeLinks, saveLink } from '../../src/minecraft/storage.ts';
import { fakeClient, fakeGuild } from './fakeGuilds.ts';

// My Minecraft accounts: any member's page for their own links (decision
// 0007), the third access level decision 0013 foresaw.
const auth: AuthConfig = { clientId: 'client-1', clientSecret: 'secret-1', origin: 'https://dash.example' };
const NOW = 1_000_000;
let time = NOW;

// u1 and u2 are plain members of g1 (no Manage Server, not the owner); u3 is in g2 only.
const members: Record<string, boolean | 'timed out'> = {};

beforeEach(() => {
	__resetForTests();
	time = NOW;
	for (const key of Object.keys(members)) delete members[key];
	Object.assign(members, { u1: false, u2: false });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function signedIn(userId = 'u1'): { Cookie: string } {
	return { Cookie: `__Host-session=${startSession({ id: userId, username: 'Alex' }, NOW).token}` };
}

function setup(ownerId?: string) {
	const linkCodes = new LinkCodes(() => time);
	const app = createApp({
		auth,
		client: fakeClient([
			fakeGuild('g1', 'Shrimp Hall', members, {}, ownerId ? { ownerId } : {}),
			fakeGuild('g2', 'Other Place', { u3: false }),
		]),
		now: () => time,
		linkCodes,
	});
	return { app, linkCodes };
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

const link = (bridgeId: string, name: string, userId: string, now = NOW) =>
	saveLink({ bridgeId, name, userId, uuid: `uuid-${name}`, now });
const linked = (bridgeId: string) => getBridgeLinks(bridgeId).map(({ name, user_id }) => ({ name, user_id }));

const PAGE = '/servers/g1/minecraft/accounts';
const post = (fields: Record<string, string>, userId = 'u1', origin = auth.origin) => ({
	method: 'POST',
	headers: { ...signedIn(userId), origin, 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(fields).toString(),
});

describe('My Minecraft accounts', () => {
	it("lists only the member's own links on this server's bridges, each with its server and a button to unlink", async () => {
		const survival = pairedBridge('g1', '<b>Survival</b>');
		const creative = pairedBridge('g1', 'Creative');
		const elsewhere = pairedBridge('g2', 'Elsewhere');
		link(survival.id, 'Steve', 'u1', Date.UTC(2026, 10, 25));
		link(creative.id, 'Alt_1', 'u1');
		link(survival.id, 'Alex', 'u2');
		link(elsewhere.id, 'Other', 'u1');

		const response = await setup().app.request(PAGE, { headers: signedIn() });
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).toContain('<h1>Shrimp Hall: My Minecraft accounts</h1>');
		expect(text).toMatch(
			/<td>Steve<\/td>\s*<td>&lt;b&gt;Survival&lt;\/b&gt;<\/td>\s*<td><time datetime="2026-11-25T00:00:00.000Z"/,
		);
		expect(text).toMatch(/<td>Alt_1<\/td>\s*<td>Creative<\/td>/);
		expect(text).toContain(`<input type="hidden" name="bridge" value="${survival.id}" />`);
		expect(text).toContain(`<form method="post" action="${PAGE}/unlink">`);
		expect(text).not.toContain('Alex');
		expect(text).not.toContain('Other');
		expect(text).not.toContain('<b>Survival');
	});

	it('offers a choice of Minecraft server only when there are several', async () => {
		const { app } = setup();

		const none = await (await app.request(PAGE, { headers: signedIn() })).text();
		expect(none).toContain("You haven't linked a Minecraft account here yet.");
		expect(none).toContain('This server has no Minecraft servers paired with the bot.');
		expect(none).not.toContain(`action="${PAGE}/code"`);

		const survival = pairedBridge();
		const one = await (await app.request(PAGE, { headers: signedIn() })).text();
		expect(one).toContain('On <strong>Survival</strong>');
		expect(one).toContain(`<input type="hidden" name="bridge" value="${survival.id}" />`);
		expect(one).not.toContain('<select');

		pairedBridge('g1', 'Creative');
		const two = await (await app.request(PAGE, { headers: signedIn() })).text();
		expect(two).toContain('<select name="bridge">');
		expect(two).toContain('Creative');
	});

	describe('getting a code', () => {
		it("gives a code for the name on that bridge, the member's own, shown once on the page", async () => {
			const { app, linkCodes } = setup();
			const bridge = pairedBridge();

			const response = await app.request(`${PAGE}/code`, post({ bridge: bridge.id, name: ' Steve ' }));
			const text = await response.text();

			expect(response.status).toBe(200);
			const code = /<code>!link (\d{6})<\/code>/.exec(text)?.[1];
			expect(code).toBeDefined();
			expect(text).toMatch(/in chat on <strong>Survival<\/strong>, logged in\s+as Steve, within 10 minutes/);
			expect(linkCodes.check(bridge.id, 'steve', code!, false)).toEqual({ kind: 'right', userId: 'u1' });
		});

		it('refuses a name Minecraft wouldn’t allow, or a bridge of another server, giving no code', async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			const elsewhere = pairedBridge('g2');

			const badName = await app.request(`${PAGE}/code`, post({ bridge: bridge.id, name: 'Steve Two' }));
			const otherBridge = await app.request(`${PAGE}/code`, post({ bridge: elsewhere.id, name: 'Steve' }));
			const noBridge = await app.request(`${PAGE}/code`, post({ name: 'Steve' }));

			expect(badName.status).toBe(400);
			const badText = await badName.text();
			expect(badText).toContain('A Minecraft name is 1 to 16 letters');
			expect(badText).toContain('value="Steve Two"');
			expect(badText).not.toContain('!link');
			expect(otherBridge.status).toBe(400);
			expect(await otherBridge.text()).toContain('Pick one of the Minecraft servers listed.');
			expect(noBridge.status).toBe(400);
		});

		it(`gives one account at most ${LINK_CODES_PER_WINDOW} codes per ${LINK_CODE_WINDOW_MS / 60_000} minutes, across servers`, async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			for (let i = 0; i < LINK_CODES_PER_WINDOW; i++) {
				const ok = await app.request(`${PAGE}/code`, post({ bridge: bridge.id, name: `Steve${i}` }));
				expect(ok.status).toBe(200);
			}

			const limited = await app.request(`${PAGE}/code`, post({ bridge: bridge.id, name: 'Steve' }));
			const someoneElse = await app.request(`${PAGE}/code`, post({ bridge: bridge.id, name: 'Alex' }, 'u2'));

			expect(limited.status).toBe(429);
			expect(limited.headers.get('retry-after')).toBe(String(LINK_CODE_WINDOW_MS / 1000));
			const text = await limited.text();
			expect(text).toContain('Wait a few minutes, then try again.');
			expect(text).not.toContain('!link');
			expect(someoneElse.status).toBe(200);
			time += LINK_CODE_WINDOW_MS;
			expect((await app.request(`${PAGE}/code`, post({ bridge: bridge.id, name: 'Steve' }))).status).toBe(200);
		});

		it('asks Discord afresh, so a member who left within the last 30 s gets no code', async () => {
			const { app, linkCodes } = setup();
			const bridge = pairedBridge();
			await app.request(PAGE, { headers: signedIn() });
			delete members['u1'];

			const response = await app.request(`${PAGE}/code`, post({ bridge: bridge.id, name: 'Steve' }));

			expect(response.status).toBe(404);
			expect(linkCodes.check(bridge.id, 'Steve', '000000', false)).toEqual({ kind: 'none' });
		});

		it('refuses a form from another site', async () => {
			const { app } = setup();
			const bridge = pairedBridge();

			const response = await app.request(
				`${PAGE}/code`,
				post({ bridge: bridge.id, name: 'Steve' }, 'u1', 'https://evil.example'),
			);

			expect(response.status).toBe(403);
		});
	});

	describe('unlinking', () => {
		it("removes the member's own link whatever the name's case, then goes back to the page", async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			link(bridge.id, 'Steve', 'u1');
			link(bridge.id, 'Alt_1', 'u1');

			const response = await app.request(`${PAGE}/unlink`, post({ bridge: bridge.id, name: 'STEVE' }));
			const again = await app.request(`${PAGE}/unlink`, post({ bridge: bridge.id, name: 'STEVE' }));

			expect(response.status).toBe(303);
			expect(response.headers.get('location')).toBe(PAGE);
			expect(again.status).toBe(303);
			expect(linked(bridge.id)).toEqual([{ name: 'Alt_1', user_id: 'u1' }]);
		});

		it("leaves someone else's link, and a bridge of another server, alone", async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			const elsewhere = pairedBridge('g2');
			link(bridge.id, 'Alex', 'u2');
			link(elsewhere.id, 'Steve', 'u1');

			await app.request(`${PAGE}/unlink`, post({ bridge: bridge.id, name: 'Alex' }));
			await app.request(`${PAGE}/unlink`, post({ bridge: elsewhere.id, name: 'Steve' }));

			expect(linked(bridge.id)).toEqual([{ name: 'Alex', user_id: 'u2' }]);
			expect(linked(elsewhere.id)).toEqual([{ name: 'Steve', user_id: 'u1' }]);
		});

		it('asks Discord afresh, so a member who left keeps nothing to change', async () => {
			const { app } = setup();
			const bridge = pairedBridge();
			link(bridge.id, 'Steve', 'u1');
			await app.request(PAGE, { headers: signedIn() });
			delete members['u1'];

			const response = await app.request(`${PAGE}/unlink`, post({ bridge: bridge.id, name: 'Steve' }));

			expect(response.status).toBe(404);
			expect(linked(bridge.id)).toEqual([{ name: 'Steve', user_id: 'u1' }]);
		});
	});

	// Decision 0014: it's about the member themselves, so timeout, which keeps
	// them from managing anything, doesn't keep them from it.
	it('lets a member in timeout see the page and get a code', async () => {
		members['u1'] = 'timed out';
		const { app } = setup();
		const bridge = pairedBridge();

		const page = await app.request(PAGE, { headers: signedIn() });
		const code = await app.request(`${PAGE}/code`, post({ bridge: bridge.id, name: 'Steve' }));

		expect(page.status).toBe(200);
		expect(code.status).toBe(200);
		expect(await code.text()).toContain('<code>!link ');
	});

	it('answers 404 to someone not in the server, as for any server page', async () => {
		pairedBridge();

		const response = await setup().app.request(PAGE, { headers: signedIn('u3') });

		expect(response.status).toBe(404);
	});

	describe('tabs', () => {
		const TABS = '<nav aria-label="Minecraft">';

		it("shows a plain member no tabs, the managers' one being hidden rather than greyed out", async () => {
			pairedBridge();

			const text = await (await setup().app.request(PAGE, { headers: signedIn() })).text();

			expect(text).not.toContain(TABS);
			expect(text).not.toContain('href="/servers/g1/minecraft"');
		});

		it('shows a manager both tabs on both pages, marking the one they are on', async () => {
			pairedBridge();
			const { app } = setup('u1');

			const accounts = await (await app.request(PAGE, { headers: signedIn() })).text();
			const manage = await (await app.request('/servers/g1/minecraft', { headers: signedIn() })).text();

			expect(accounts).toContain(TABS);
			expect(accounts).toContain('<li><a href="/servers/g1/minecraft">Minecraft servers</a></li>');
			expect(accounts).toContain('<li><strong aria-current="page">My Minecraft accounts</strong></li>');
			expect(manage).toContain(TABS);
			expect(manage).toContain('<li><strong aria-current="page">Minecraft servers</strong></li>');
			expect(manage).toContain(`<li><a href="${PAGE}">My Minecraft accounts</a></li>`);
		});
	});

	describe('in the server list', () => {
		it('lists a server with a Minecraft server to a plain member, linking only their accounts', async () => {
			pairedBridge();

			const text = await (await setup().app.request('/servers', { headers: signedIn() })).text();

			expect(text).toContain(`<a href="${PAGE}">Shrimp Hall</a> (My Minecraft accounts)`);
			expect(text).not.toContain('href="/servers/g1"');
			expect(text).not.toContain('Other Place');
		});

		it('leaves out a server without one, where a plain member has nothing to do', async () => {
			const text = await (await setup().app.request('/servers', { headers: signedIn() })).text();

			expect(text).toContain('No servers to show');
		});

		it('adds the link beside the pages of a member who manages the server', async () => {
			members['u1'] = true;
			pairedBridge();

			const text = await (await setup().app.request('/servers', { headers: signedIn() })).text();

			expect(text).toContain('<a href="/servers/g1">Shrimp Hall</a>');
			expect(text).toContain(`<a href="${PAGE}">My Minecraft accounts</a>`);
		});
	});
});
