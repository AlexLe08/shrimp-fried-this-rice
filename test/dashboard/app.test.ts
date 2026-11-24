import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp } from '../../src/dashboard/app.ts';
import type { AuthConfig, Fetch } from '../../src/dashboard/auth.ts';
import { sessionFromToken, startSession } from '../../src/dashboard/sessions.ts';
import { __resetForTests } from '../../src/core/database.ts';
import { LOGINS_PER_MINUTE } from '../../src/dashboard/loginGate.ts';
import {
	USER_REQUESTS_PER_MINUTE,
	VISITOR_LOGIN_WINDOW_MS,
	VISITOR_LOGINS_PER_WINDOW,
	VISITOR_REQUESTS_PER_MINUTE,
} from '../../src/dashboard/rateLimit.ts';

const ORIGIN = 'https://dash.example';
const auth: AuthConfig = { clientId: 'client-1', clientSecret: 'secret-1', origin: ORIGIN };
const NOW = 1_000_000;

beforeEach(() => {
	__resetForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function fakeDiscord(user: object = { id: 'u1', username: 'alex', global_name: 'Alex' }): Mock<Fetch> {
	return vi.fn<Fetch>(async (input) => {
		const url = String(input);
		if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'access-1' });
		if (url.endsWith('/users/@me')) return Response.json(user);
		if (url.endsWith('/oauth2/token/revoke')) return new Response(null, { status: 200 });
		throw new Error(`unexpected ${url}`);
	});
}

function loginApp(fetchFn = fakeDiscord()) {
	return createApp({ auth, fetch: fetchFn, now: () => NOW });
}

/** Set-Cookie headers by cookie name. */
function setCookies(response: Response): Record<string, string> {
	return Object.fromEntries(
		response.headers.getSetCookie().map((cookie) => [cookie.slice(0, cookie.indexOf('=')), cookie]),
	);
}

function cookieValue(setCookie: string | undefined): string {
	return setCookie!.slice(setCookie!.indexOf('=') + 1, setCookie!.indexOf(';'));
}

/** Starts a login and returns the state Discord would send back, with its cookie. */
async function beginLogin(app: ReturnType<typeof createApp>): Promise<{ state: string; cookie: string }> {
	const response = await app.request('/login');
	const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
	return { state, cookie: `__Host-oauth_state=${cookieValue(setCookies(response)['__Host-oauth_state'])}` };
}

describe('dashboard app', () => {
	it('answers /health with ok', async () => {
		const response = await createApp().request('/health');

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('answers 404 for a path it has no route for', async () => {
		const response = await createApp().request('/nothing-here');

		expect(response.status).toBe(404);
	});

	it('sends security headers, refusing to be framed by another site', async () => {
		const response = await createApp().request('/');

		expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-security-policy')).toBe(
			"default-src 'none'; form-action 'self'; frame-ancestors 'none'",
		);
	});

	// With no-referrer, browsers send `Origin: null` on the dashboard's own
	// form posts, so the CSRF check's origin match could never pass.
	it('sends Referrer-Policy: same-origin, not no-referrer', async () => {
		expect((await createApp().request('/')).headers.get('referrer-policy')).toBe('same-origin');
	});

	it('tells browsers not to store pages, which name the signed-in user', async () => {
		expect((await createApp().request('/')).headers.get('cache-control')).toBe('no-store');
		expect((await loginApp().request('/login')).headers.get('cache-control')).toBe('no-store');
	});
});

describe('without login set up', () => {
	it('says so on the home page and answers 503 for the login routes', async () => {
		const app = createApp({ auth: null });

		expect(await (await app.request('/')).text()).toContain("Login isn't set up");
		expect((await app.request('/login')).status).toBe(503);
		expect((await app.request('/auth/callback?code=c&state=s')).status).toBe(503);
	});
});

describe('home page', () => {
	it('offers login to a visitor without a session', async () => {
		const text = await (await loginApp().request('/')).text();

		expect(text).toContain('href="/login"');
		expect(text).not.toContain('Signed in');
	});

	it('names the signed-in user, escaped, with a log-out form', async () => {
		const { token } = startSession({ id: 'u1', username: '<b>Alex</b>' }, NOW);

		const text = await (await loginApp().request('/', { headers: { Cookie: `__Host-session=${token}` } })).text();

		expect(text).toContain('Signed in as &lt;b&gt;Alex&lt;/b&gt;.');
		expect(text).toContain('action="/logout"');
	});

	it('treats an expired session as signed out', async () => {
		const { token } = startSession({ id: 'u1', username: 'Alex' }, NOW - 8 * 24 * 60 * 60 * 1000);

		const text = await (await loginApp().request('/', { headers: { Cookie: `__Host-session=${token}` } })).text();

		expect(text).not.toContain('Signed in');
	});

	it('ignores a session cookie without the __Host- prefix, which another site under the domain could set', async () => {
		const { token } = startSession({ id: 'u1', username: 'Alex' }, NOW);

		const text = await (await loginApp().request('/', { headers: { Cookie: `session=${token}` } })).text();

		expect(text).not.toContain('Signed in');
	});
});

describe('/login', () => {
	it('redirects to Discord with a fresh state, kept in a short-lived __Host- cookie', async () => {
		const app = loginApp();
		const response = await app.request('/login');

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get('location')!);
		expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
		const state = location.searchParams.get('state')!;
		expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
		const cookie = setCookies(response)['__Host-oauth_state']!;
		expect(cookieValue(cookie)).toBe(state);
		expect(cookie).toContain('Max-Age=600');
		expect(cookie).toContain('Path=/');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).not.toContain('Domain');

		const second = new URL((await app.request('/login')).headers.get('location')!).searchParams.get('state');
		expect(second).not.toBe(state);
	});
});

describe('/auth/callback', () => {
	it('signs the user in: a session cookie, the state cookie cleared, and back to the home page', async () => {
		const fetchFn = fakeDiscord();
		const app = loginApp(fetchFn);
		const { state, cookie } = await beginLogin(app);

		const response = await app.request(`/auth/callback?code=code-1&state=${state}`, { headers: { Cookie: cookie } });

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/');
		const cookies = setCookies(response);
		expect(cookies['__Host-oauth_state']).toContain('Max-Age=0');
		const sessionCookie = cookies['__Host-session']!;
		expect(sessionCookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
		expect(sessionCookie).toContain('HttpOnly');
		expect(sessionCookie).toContain('Secure');
		expect(sessionCookie).toContain('SameSite=Lax');
		expect(sessionFromToken(cookieValue(sessionCookie), NOW)).toMatchObject({ user_id: 'u1', username: 'Alex' });
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});

	it("ends the browser's earlier session when it logs in again", async () => {
		const app = loginApp();
		const earlier = startSession({ id: 'u1', username: 'Alex' }, NOW).token;
		const { state, cookie } = await beginLogin(app);

		await app.request(`/auth/callback?code=code-1&state=${state}`, {
			headers: { Cookie: `${cookie}; __Host-session=${earlier}` },
		});

		expect(sessionFromToken(earlier, NOW)).toBeUndefined();
	});

	it.each([
		['a state that differs from the cookie', (state: string) => `code=code-1&state=${state}x`, true],
		['no state', () => 'code=code-1', true],
		['no code', (state: string) => `state=${state}`, true],
		['no state cookie (another browser started the login)', (state: string) => `code=code-1&state=${state}`, false],
	])('refuses %s, without asking Discord or starting a session', async (_case, query, withCookie) => {
		const fetchFn = fakeDiscord();
		const app = loginApp(fetchFn);
		const { state, cookie } = await beginLogin(app);

		const response = await app.request(`/auth/callback?${query(state)}`, {
			headers: withCookie ? { Cookie: cookie } : {},
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('expired or is invalid');
		expect(setCookies(response)['__Host-session']).toBeUndefined();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it(`refuses logins beyond ${LOGINS_PER_MINUTE} a minute without asking Discord`, async () => {
		const fetchFn = fakeDiscord();
		const app = loginApp(fetchFn);
		// Each from its own visitor, so the per-visitor limit doesn't stop them first.
		const from = (i: number, cookie: string) => ({ Cookie: cookie, 'CF-Connecting-IP': `198.51.100.${i}` });
		for (let i = 0; i < LOGINS_PER_MINUTE; i++) {
			const { state, cookie } = await beginLogin(app);
			await app.request(`/auth/callback?code=code-1&state=${state}`, { headers: from(i, cookie) });
		}
		fetchFn.mockClear();
		const { state, cookie } = await beginLogin(app);

		const response = await app.request(`/auth/callback?code=code-1&state=${state}`, {
			headers: from(LOGINS_PER_MINUTE, cookie),
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toContain('Too many logins right now');
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('stops asking Discord after its 429 until the Retry-After has passed', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let time = NOW;
		const fetchFn = vi.fn<Fetch>(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }));
		const app = createApp({ auth, fetch: fetchFn, now: () => time });
		const callback = async () => {
			const { state, cookie } = await beginLogin(app);
			return app.request(`/auth/callback?code=code-1&state=${state}`, { headers: { Cookie: cookie } });
		};

		expect((await callback()).status).toBe(502);
		expect((await callback()).status).toBe(429);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		time += 30_000;
		await callback();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("says the login was cancelled when the visitor cancelled Discord's page", async () => {
		const app = loginApp();
		const { state, cookie } = await beginLogin(app);

		const response = await app.request(`/auth/callback?error=access_denied&state=${state}`, {
			headers: { Cookie: cookie },
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('cancelled');
	});

	it('answers 502, logging why, when Discord fails the login', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fetchFn = vi.fn(async () => new Response('down', { status: 500 }));
		const app = loginApp(fetchFn);
		const { state, cookie } = await beginLogin(app);

		const response = await app.request(`/auth/callback?code=code-1&state=${state}`, { headers: { Cookie: cookie } });

		expect(response.status).toBe(502);
		expect(setCookies(response)['__Host-session']).toBeUndefined();
		expect(error).toHaveBeenCalledWith('Dashboard login failed:', expect.any(Error));
	});
});

describe('/logout', () => {
	function logout(app: ReturnType<typeof createApp>, token: string, headers: Record<string, string>) {
		return app.request('/logout', {
			method: 'POST',
			headers: { Cookie: `__Host-session=${token}`, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
		});
	}

	it("ends the session and clears its cookie, from the dashboard's own page", async () => {
		const app = loginApp();
		const { token } = startSession({ id: 'u1', username: 'Alex' }, NOW);

		const response = await logout(app, token, { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' });

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/');
		expect(setCookies(response)['__Host-session']).toContain('Max-Age=0');
		expect(sessionFromToken(token, NOW)).toBeUndefined();
	});

	it.each([
		['the Origin alone (a browser without Sec-Fetch-Site)', { Origin: ORIGIN }],
		['Sec-Fetch-Site alone', { 'Sec-Fetch-Site': 'same-origin' }],
	])('accepts a log-out with %s', async (_case, headers) => {
		const app = loginApp();
		const { token } = startSession({ id: 'u1', username: 'Alex' }, NOW);

		expect((await logout(app, token, headers)).status).toBe(303);
		expect(sessionFromToken(token, NOW)).toBeUndefined();
	});

	it.each([
		['another site', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }],
		['a sibling site under the same domain', { Origin: 'https://other.dash.example', 'Sec-Fetch-Site': 'same-site' }],
		['a client sending neither header', {}],
	])('refuses a form post from %s, keeping the session', async (_case, headers) => {
		const app = loginApp();
		const { token } = startSession({ id: 'u1', username: 'Alex' }, NOW);

		const response = await logout(app, token, headers);

		expect(response.status).toBe(403);
		expect(sessionFromToken(token, NOW)).toBeDefined();
	});
});

describe('rate limits', () => {
	const visitor = (ip: string) => ({ 'CF-Connecting-IP': ip });

	it(`refuses a visitor's requests beyond ${VISITOR_REQUESTS_PER_MINUTE} a minute, with Retry-After`, async () => {
		let time = NOW;
		const app = createApp({ auth, now: () => time });
		for (let i = 0; i < VISITOR_REQUESTS_PER_MINUTE; i++) {
			expect((await app.request('/', { headers: visitor('203.0.113.7') })).status).toBe(200);
		}
		time += 20_000;

		const response = await app.request('/', { headers: visitor('203.0.113.7') });

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('40');
		expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
		expect(await response.text()).toContain('Too many requests from your network');
		expect((await app.request('/', { headers: visitor('198.51.100.1') })).status).toBe(200);
		time += 40_000;
		expect((await app.request('/', { headers: visitor('203.0.113.7') })).status).toBe(200);
	});

	it('counts every address in an IPv6 /64 as one visitor', async () => {
		const app = createApp({ auth, now: () => NOW });
		for (let i = 0; i < VISITOR_REQUESTS_PER_MINUTE; i++) {
			await app.request('/', { headers: visitor(`2001:db8:1:2::${i.toString(16)}`) });
		}

		expect((await app.request('/', { headers: visitor('2001:db8:1:2::ffff') })).status).toBe(429);
		expect((await app.request('/', { headers: visitor('2001:db8:1:3::1') })).status).toBe(200);
	});

	it('leaves /health out of the visitor limit', async () => {
		const app = createApp({ auth, now: () => NOW });
		for (let i = 0; i < VISITOR_REQUESTS_PER_MINUTE; i++) await app.request('/', { headers: visitor('203.0.113.7') });

		expect((await app.request('/health', { headers: visitor('203.0.113.7') })).status).toBe(200);
	});

	it(`refuses a visitor's logins beyond ${VISITOR_LOGINS_PER_WINDOW} in ${VISITOR_LOGIN_WINDOW_MS / 60_000} minutes without asking Discord`, async () => {
		let time = NOW;
		const fetchFn = fakeDiscord();
		const app = createApp({ auth, fetch: fetchFn, now: () => time });
		const callback = async (ip: string) => {
			const { state, cookie } = await beginLogin(app);
			return app.request(`/auth/callback?code=code-1&state=${state}`, { headers: { Cookie: cookie, ...visitor(ip) } });
		};
		for (let i = 0; i < VISITOR_LOGINS_PER_WINDOW; i++) expect((await callback('203.0.113.7')).status).toBe(302);
		fetchFn.mockClear();

		const response = await callback('203.0.113.7');

		expect(response.status).toBe(429);
		expect(await response.text()).toContain('Too many logins from your network');
		expect(fetchFn).not.toHaveBeenCalled();
		expect((await callback('198.51.100.1')).status).toBe(302);
		time += VISITOR_LOGIN_WINDOW_MS;
		expect((await callback('203.0.113.7')).status).toBe(302);
	});

	it(`refuses an account's signed-in pages beyond ${USER_REQUESTS_PER_MINUTE} a minute, whatever session or address`, async () => {
		const app = createApp({ auth, now: () => NOW });
		const session = () => `__Host-session=${startSession({ id: 'u1', username: 'Alex' }, NOW).token}`;
		for (let i = 0; i < USER_REQUESTS_PER_MINUTE; i++) {
			const response = await app.request('/servers', { headers: { Cookie: session(), ...visitor(`198.51.100.${i}`) } });
			expect(response.status).toBe(200);
		}

		const response = await app.request('/servers', { headers: { Cookie: session(), ...visitor('203.0.113.7') } });

		expect(response.status).toBe(429);
		expect(await response.text()).toContain('Too many requests from your account');
		const otherUser = `__Host-session=${startSession({ id: 'u2', username: 'Sam' }, NOW).token}`;
		expect((await app.request('/servers', { headers: { Cookie: otherUser } })).status).toBe(200);
	});
});
