import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { authorizeUrl, discordUserFromCode, type AuthConfig, type Fetch } from './auth.ts';
import { homePage, messagePage } from './pages.ts';
import { endSession, sessionFromToken, startSession } from './sessions.ts';
import { SESSION_LIFETIME_MS } from './storage.ts';

export interface AppOptions {
	/** Login's settings; null serves the dashboard without login. */
	auth: AuthConfig | null;
	fetch?: Fetch;
	now?: () => number;
}

// Both __Host-: only this exact hostname can set them, so another site under
// alexle.dev can't plant or overwrite one (decision 0009).
const SESSION_COOKIE = 'session';
const STATE_COOKIE = 'oauth_state';
const STATE_LIFETIME_S = 10 * 60;

const cookieOptions = { prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const;

function sameState(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function createApp(options: AppOptions = { auth: null }): Hono {
	const { auth } = options;
	const fetchFn = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const app = new Hono();

	app.use(secureHeaders());
	// Form posts only from the dashboard's own pages: the exact public origin
	// (behind the tunnel the request's own URL is 127.0.0.1's), and a browser's
	// Sec-Fetch-Site of same-origin, which a sibling site under alexle.dev
	// (same-site) doesn't get.
	app.use(csrf({ origin: auth ? auth.origin : [], secFetchSite: 'same-origin' }));

	// For checking that the tunnel reaches the bot: it touches neither Discord nor the database.
	app.get('/health', (c) => c.text('ok'));

	app.get('/', (c) => {
		const session = sessionFromToken(getCookie(c, SESSION_COOKIE, 'host'), now());
		return c.html(homePage(session ? session.username : null, auth !== null));
	});

	const loginOff = (c: Context) => c.html(messagePage('Login unavailable', "Login isn't set up on this bot."), 503);

	app.get('/login', (c) => {
		if (!auth) return loginOff(c);
		const state = randomBytes(16).toString('base64url');
		setCookie(c, STATE_COOKIE, state, { ...cookieOptions, maxAge: STATE_LIFETIME_S });
		return c.redirect(authorizeUrl(auth, state), 302);
	});

	app.get('/auth/callback', async (c) => {
		if (!auth) return loginOff(c);
		const expected = getCookie(c, STATE_COOKIE, 'host');
		deleteCookie(c, STATE_COOKIE, cookieOptions);
		const { code, state, error } = c.req.query();
		if (error) {
			return c.html(messagePage('Login cancelled', "You weren't logged in: Discord's page was cancelled."), 400);
		}
		// The state ties this callback to a login this browser started, so a
		// link from someone else can't sign the visitor in as them.
		if (!code || !state || !expected || !sameState(state, expected)) {
			return c.html(messagePage('Login expired', 'That login link has expired or is invalid. Please try again.'), 400);
		}

		let user;
		try {
			user = await discordUserFromCode(auth, code, fetchFn);
		} catch (cause) {
			console.error('Dashboard login failed:', cause);
			return c.html(messagePage('Login failed', "Discord didn't complete the login. Please try again."), 502);
		}

		endSession(getCookie(c, SESSION_COOKIE, 'host'));
		const { token } = startSession({ id: user.id, username: user.name }, now());
		setCookie(c, SESSION_COOKIE, token, { ...cookieOptions, maxAge: Math.floor(SESSION_LIFETIME_MS / 1000) });
		return c.redirect('/', 302);
	});

	app.post('/logout', (c) => {
		endSession(getCookie(c, SESSION_COOKIE, 'host'));
		deleteCookie(c, SESSION_COOKIE, cookieOptions);
		return c.redirect('/', 303);
	});

	return app;
}
