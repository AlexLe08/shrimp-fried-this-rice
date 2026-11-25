import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { DiscordRateLimitedError, authorizeUrl, discordUserFromCode, type AuthConfig, type Fetch } from './auth.ts';
import { serverAccess, type DashboardClient, type ServerRights } from './access.ts';
import { createLoginGate } from './loginGate.ts';
import {
	MINUTE_MS,
	USER_REQUESTS_PER_MINUTE,
	VISITOR_LOGIN_WINDOW_MS,
	VISITOR_LOGINS_PER_WINDOW,
	VISITOR_REQUESTS_PER_MINUTE,
	UNKNOWN_VISITOR,
	createRateLimiter,
	visitorKey,
} from './rateLimit.ts';
import {
	addBridgePage,
	homePage,
	messagePage,
	minecraftPage,
	pairedPage,
	serverPage,
	serversPage,
	type AddBridgeProblem,
} from './pages.ts';
import { endSession, sessionFromToken, startSession } from './sessions.ts';
import { SESSION_LIFETIME_MS, type DashboardSession } from './storage.ts';
import { MAX_REMINDERS_PER_GUILD, getGuildReminders, isGuildMasterEnabled } from '../reminders/storage.ts';
import { reminderState } from '../reminders/reminderState.ts';
import type { Announcer } from '../minecraft/announcement.ts';
import type { BridgePairing } from '../minecraft/dashboardPairing.ts';
import { HelperHub } from '../minecraft/helperHub.ts';
import { registerHelperRoutes } from '../minecraft/helperRoutes.ts';
import { MAX_BRIDGES_PER_GUILD, getGuildBridges } from '../minecraft/storage.ts';

export interface AppOptions {
	/** Login's settings; null serves the dashboard without login. */
	auth: AuthConfig | null;
	/** The bot's client, to see which servers a user may manage; without it none are shown. */
	client?: DashboardClient | null;
	fetch?: Fetch;
	now?: () => number;
	/** The Minecraft helpers' sessions and waiting messages; a new, empty one if not given. */
	helpers?: HelperHub;
	/** Announces a bridge's relay when its helper is first active; without it, none is announced. */
	announcer?: Announcer;
	/** Pairs Minecraft bridges with the bot's client; without it, none can be added. */
	pairing?: BridgePairing;
}

type Env = { Variables: { session: DashboardSession; server: ServerRights } };

/**
 * Who may reach each route, which a test checks against the app's routes, so
 * a new route can't be added without saying (decision 0009: deny by default).
 * `signed-in` routes go through requireSession. `server` and `bridges` routes
 * are under /servers/:guildId, where requireServer checks the user has a right
 * in that server before any handler runs, then the route's own `requires`
 * checks the right it needs: Manage Server for `server` (decision 0012), the
 * server's owner or allowed role for `bridges` (decision 0013). `helper`
 * routes are the Minecraft helper's, which open only with a bridge's keys
 * (minecraft/helperRoutes.ts).
 */
export const ROUTE_ACCESS = {
	'GET /health': 'public',
	'GET /': 'public',
	'GET /login': 'public',
	'GET /auth/callback': 'public',
	'POST /logout': 'public',
	'GET /servers': 'signed-in',
	'GET /servers/:guildId': 'server',
	'GET /servers/:guildId/minecraft': 'bridges',
	'GET /servers/:guildId/minecraft/new': 'bridges',
	'POST /servers/:guildId/minecraft/new': 'bridges',
	'POST /minecraft/connect': 'helper',
	'POST /minecraft/poll': 'helper',
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
	const visitorRequests = createRateLimiter(VISITOR_REQUESTS_PER_MINUTE, MINUTE_MS, now);
	const visitorLogins = createRateLimiter(VISITOR_LOGINS_PER_WINDOW, VISITOR_LOGIN_WINDOW_MS, now);
	const userRequests = createRateLimiter(USER_REQUESTS_PER_MINUTE, MINUTE_MS, now);

	const tooMany = (c: Context, waitMs: number, message: string) => {
		c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
		return c.html(messagePage('Too many requests', message), 429);
	};

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
	// Without a usable address every visitor shares one count, which would
	// look like the dashboard turning everyone away, so say so once.
	let warnedNoAddress = false;
	const visitorOf = (c: Context) => {
		const key = visitorKey(c.req.header('cf-connecting-ip'));
		if (key === UNKNOWN_VISITOR && !warnedNoAddress) {
			warnedNoAddress = true;
			console.warn(
				'Dashboard: a request came without a usable CF-Connecting-IP; all such requests share one rate limit.',
			);
		}
		return key;
	};
	// /health is left out: it touches neither Discord nor the database. So are
	// the helper's routes, which have their own limits: a busy bridge polls
	// more often than this allows a visitor.
	app.use(async (c, next) => {
		if (c.req.path === '/health' || c.req.path.startsWith('/minecraft/')) return next();
		const wait = visitorRequests.take(visitorOf(c));
		if (wait > 0) return tooMany(c, wait, 'Too many requests from your network. Please try again in a minute.');
		return next();
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

		// Before the dashboard-wide gate, so one visitor can't use up everyone's logins.
		const wait = visitorLogins.take(visitorOf(c));
		if (wait > 0) return tooMany(c, wait, 'Too many logins from your network. Please try again in a few minutes.');
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
		// Per account, whichever sessions and addresses it uses: its pages may ask Discord about its servers.
		const wait = userRequests.take(session.user_id);
		if (wait > 0) return tooMany(c, wait, 'Too many requests from your account. Please try again in a minute.');
		c.set('session', session);
		return next();
	};

	// One answer, 404, whether the bot isn't in the server, the user isn't a
	// member, or they can't manage it: none tells a visitor the server exists.
	const requireServer: MiddlewareHandler<Env> = async (c, next) => {
		const rights = access && (await access.rightsIn(c.req.param('guildId') ?? '', c.get('session').user_id));
		if (!rights || !(rights.manageServer || rights.manageBridges)) return notFound(c);
		c.set('server', rights);
		return next();
	};

	// Each server route names the right it needs, after requireServer has
	// found the user's rights; the same 404 for one they lack.
	const requires =
		(level: 'server' | 'bridges'): MiddlewareHandler<Env> =>
		async (c, next) => {
			const rights = c.get('server');
			return (level === 'server' ? rights.manageServer : rights.manageBridges) ? next() : notFound(c);
		};

	app.use('/servers', requireSession);
	// The wildcard matches /servers/:guildId itself too, so one registration
	// covers the server's page and everything under it.
	app.use('/servers/:guildId/*', requireSession, requireServer);

	app.get('/servers', async (c) => {
		const servers = access ? await access.serversWithRights(c.get('session').user_id) : [];
		return c.html(serversPage(servers));
	});

	app.get('/servers/:guildId', requires('server'), (c) => {
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

	app.get('/servers/:guildId/minecraft', requires('bridges'), (c) => {
		const server = c.get('server');
		const channels = options.client?.guilds.cache.get(server.id)?.channels.cache;
		const channel = (id: string) => ({ id, name: channels?.get(id)?.name ?? null });
		const bridges = getGuildBridges(server.id).map((bridge) => ({
			serverName: bridge.server_name,
			chat: channel(bridge.chat_channel_id),
			alerts: channel(bridge.alerts_channel_id),
			announced: bridge.announced_channel_id === bridge.chat_channel_id,
		}));
		return c.html(minecraftPage(server, { bridges, max: MAX_BRIDGES_PER_GUILD }));
	});

	const pairingOff = (c: Context) =>
		c.html(messagePage('Pairing unavailable', "Minecraft servers can't be paired on this bot."), 503);
	const atLimit = (guildId: string) => getGuildBridges(guildId).length >= MAX_BRIDGES_PER_GUILD;

	app.get('/servers/:guildId/minecraft/new', requires('bridges'), async (c) => {
		const server = c.get('server');
		if (!options.pairing) return pairingOff(c);
		if (atLimit(server.id)) return c.html(addBridgePage(server, { kind: 'limit', max: MAX_BRIDGES_PER_GUILD }));
		// Asked of Discord, not the access cache, so the form offers exactly the
		// channels pairing would accept from them now.
		const choices = await options.pairing.channelChoices(server.id, c.get('session').user_id);
		if (!choices) return notFound(c);
		return c.html(addBridgePage(server, { kind: 'form', choices }));
	});

	app.post('/servers/:guildId/minecraft/new', requires('bridges'), async (c) => {
		const server = c.get('server');
		const pairing = options.pairing;
		if (!pairing || !auth) return pairingOff(c);
		const userId = c.get('session').user_id;
		const body = await c.req.parseBody();
		const field = (name: string) => {
			const value = body[name];
			return typeof value === 'string' ? value.trim() : '';
		};
		const values = { serverName: field('serverName'), chat: field('chat'), alerts: field('alerts') };
		const channels = options.client?.guilds.cache.get(server.id)?.channels.cache;

		// The form again, with what they sent and what to fix.
		const again = async (problem: AddBridgeProblem, status: 400 | 502) => {
			const choices = await pairing.channelChoices(server.id, userId);
			if (!choices) return notFound(c);
			const channelName = (id: string) => channels?.get(id)?.name ?? null;
			return c.html(addBridgePage(server, { kind: 'form', choices, values, problem, channelName }), status);
		};
		if (!values.chat || !values.alerts) return again({ reason: 'no-channel' }, 400);

		const answer = await pairing.pair({
			guildId: server.id,
			userId,
			chatChannelId: values.chat,
			alertsChannelId: values.alerts,
			serverName: values.serverName,
			dashboardUrl: auth.origin,
		});
		if (answer.ok) return c.html(pairedPage(server, { serverName: answer.bridge.server_name, config: answer.config }));
		// Checked fresh, they may no longer: the same 404 as the guard's.
		if (answer.reason === 'not-allowed') return notFound(c);
		if (answer.reason === 'bridge-limit') return c.html(addBridgePage(server, { kind: 'limit', max: answer.max }), 400);
		return again(answer, answer.reason === 'error' ? 502 : 400);
	});

	app.post('/logout', (c) => {
		endSession(getCookie(c, SESSION_COOKIE, 'host'));
		deleteCookie(c, SESSION_COOKIE, cookieOptions);
		return c.redirect('/', 303);
	});

	registerHelperRoutes(app, {
		hub: options.helpers ?? new HelperHub(now),
		now,
		visitorOf,
		...(options.announcer && { announcer: options.announcer }),
	});

	return app;
}
