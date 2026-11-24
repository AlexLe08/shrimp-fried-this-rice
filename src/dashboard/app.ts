import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { DiscordRateLimitedError, authorizeUrl, discordUserFromCode, type AuthConfig, type Fetch } from './auth.ts';
import { serverAccess, type DashboardClient, type ManagedServer } from './access.ts';
import { createLoginGate } from './loginGate.ts';
import { homePage, messagePage, serverPage, serversPage } from './pages.ts';
import { endSession, sessionFromToken, startSession } from './sessions.ts';
import { SESSION_LIFETIME_MS, type DashboardSession } from './storage.ts';
import { MAX_REMINDERS_PER_GUILD, getGuildReminders, isGuildMasterEnabled } from '../reminders/storage.ts';
import { reminderState } from '../reminders/reminderState.ts';

export interface AppOptions {
	/** Login's settings; null serves the dashboard without login. */
	auth: AuthConfig | null;
	/** The bot's client, to see which servers a user may manage; without it none are shown. */
	client?: DashboardClient | null;
	fetch?: Fetch;
	now?: () => number;
}

type Env = { Variables: { session: DashboardSession; server: ManagedServer } };

/**
 * Who may reach each route, which a test checks against the app's routes, so
 * a new route can't be added without saying (decision 0009: deny by default).
 * `signed-in` routes go through requireSession; `server` routes are under
 * /servers/:guildId, where requireServer checks the user may manage that
 * server before any handler runs.
 */
export const ROUTE_ACCESS = {
	'GET /health': 'public',
	'GET /': 'public',
	'GET /login': 'public',
	'GET /auth/callback': 'public',
	'POST /logout': 'public',
	'GET /servers': 'signed-in',
	'GET /servers/:guildId': 'server',
} as const;

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

export function createApp(options: AppOptions = { auth: null }): Hono<Env> {
	const { auth } = options;
	const fetchFn = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const access = options.client ? serverAccess(options.client, now) : null;
	const app = new Hono<Env>();
	const loginGate = createLoginGate(now);

	app.use(
		secureHeaders({
			// Hono's default, no-referrer, makes browsers send `Origin: null` on the
			// dashboard's own form posts, which the CSRF check below then can't match.
			referrerPolicy: 'same-origin',
			// The pages have no scripts, styles or images, and post forms only to the dashboard.
			contentSecurityPolicy: { defaultSrc: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"] },
		}),
	);
	// Pages name the signed-in user, so the browser mustn't show a stored copy
	// after log-out (going back), nor keep one for the next person on the machine.
	app.use(async (c, next) => {
		await next();
		c.header('Cache-Control', 'no-store');
	});
	// Form posts only from the dashboard's own pages. Either check lets one
	// through: an Origin of the exact public origin (behind the tunnel the
	// request's own URL is 127.0.0.1's), or Sec-Fetch-Site: same-origin. A
	// sibling site under alexle.dev has its own Origin and is same-site, so it
	// passes neither.
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

		if (!loginGate.tryTake()) {
			return c.html(messagePage('Too many logins', 'Too many logins right now. Please try again in a minute.'), 429);
		}
		let user;
		try {
			user = await discordUserFromCode(auth, code, fetchFn);
		} catch (cause) {
			if (cause instanceof DiscordRateLimitedError) loginGate.blockFor(cause.retryAfterMs);
			console.error('Dashboard login failed:', cause);
			return c.html(messagePage('Login failed', "Discord didn't complete the login. Please try again."), 502);
		}

		endSession(getCookie(c, SESSION_COOKIE, 'host'));
		const { token } = startSession({ id: user.id, username: user.name }, now());
		setCookie(c, SESSION_COOKIE, token, { ...cookieOptions, maxAge: Math.floor(SESSION_LIFETIME_MS / 1000) });
		return c.redirect('/', 302);
	});

	const notFound = (c: Context) =>
		c.html(messagePage('Not found', "There's nothing here, or it isn't yours to see."), 404);

	// Signed out, back to the home page, which offers login.
	const requireSession: MiddlewareHandler<Env> = async (c, next) => {
		const session = sessionFromToken(getCookie(c, SESSION_COOKIE, 'host'), now());
		if (!session) return c.redirect('/', 302);
		c.set('session', session);
		return next();
	};

	// One answer, 404, whether the bot isn't in the server, the user isn't a
	// member, or they can't manage it: none tells a visitor the server exists.
	const requireServer: MiddlewareHandler<Env> = async (c, next) => {
		const server = access && (await access.serverUserManages(c.req.param('guildId') ?? '', c.get('session').user_id));
		if (!server) return notFound(c);
		c.set('server', server);
		return next();
	};

	app.use('/servers', requireSession);
	// The wildcard matches /servers/:guildId itself too, so one registration
	// covers the server's page and everything under it.
	app.use('/servers/:guildId/*', requireSession, requireServer);

	app.get('/servers', async (c) => {
		const servers = access ? await access.serversUserManages(c.get('session').user_id) : [];
		return c.html(serversPage(servers));
	});

	app.get('/servers/:guildId', (c) => {
		const server = c.get('server');
		const time = now();
		const masterEnabled = isGuildMasterEnabled(server.id);
		const channels = options.client?.guilds.cache.get(server.id)?.channels.cache;
		const reminders = getGuildReminders(server.id).map((reminder) => ({
			label: reminder.reminder_label,
			channelId: reminder.channel_id,
			channelName: channels?.get(reminder.channel_id)?.name ?? null,
			intervalMinutes: reminder.interval_minutes,
			message: reminder.message,
			embed: reminder.embed === 1,
			state: reminderState(reminder, masterEnabled, time),
		}));
		return c.html(serverPage(server, { masterEnabled, reminders, max: MAX_REMINDERS_PER_GUILD, now: time }));
	});

	app.post('/logout', (c) => {
		endSession(getCookie(c, SESSION_COOKIE, 'host'));
		deleteCookie(c, SESSION_COOKIE, cookieOptions);
		return c.redirect('/', 303);
	});

	return app;
}
