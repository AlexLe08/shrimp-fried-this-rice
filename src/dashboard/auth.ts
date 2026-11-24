const DISCORD_API = 'https://discord.com/api/v10';
// A Discord call that hangs would otherwise hold the visitor's request, and
// shutdown, until a timeout far above anything a login should take.
const DISCORD_TIMEOUT_MS = 10_000;

export interface AuthConfig {
	clientId: string;
	clientSecret: string;
	/** The dashboard's public origin, e.g. https://shrimp-fried-rice.alexle.dev: behind the tunnel the request's own URL is http://127.0.0.1. */
	origin: string;
}

export interface DiscordUser {
	id: string;
	/** The name shown on the dashboard: the display name if set, else the username. */
	name: string;
}

export type Fetch = typeof fetch;

// When Discord's 429 doesn't say how long to wait.
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** Discord answered 429: no more logins until `retryAfterMs` has passed. */
export class DiscordRateLimitedError extends Error {
	readonly retryAfterMs: number;

	constructor(retryAfterMs: number) {
		super(`Discord rate limited dashboard logins for ${Math.ceil(retryAfterMs / 1000)} s`);
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * Login's settings from `.env`, or null when the dashboard runs without
 * login: none of them set (a dev bot), or one missing or malformed (logged).
 */
export function authConfigFromEnv(env: NodeJS.ProcessEnv): AuthConfig | null {
	const clientId = env['DISCORD_CLIENT_ID'];
	const clientSecret = env['DISCORD_CLIENT_SECRET'];
	const url = env['DASHBOARD_URL'];
	if (!clientSecret && !url) return null;
	if (!clientId || !clientSecret || !url) {
		console.error('Dashboard login is off: set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DASHBOARD_URL in .env.');
		return null;
	}
	const parsed = URL.parse(url);
	const local = parsed?.hostname === '127.0.0.1' || parsed?.hostname === 'localhost';
	// Plain http only on this machine: elsewhere it would send the session cookie unencrypted.
	if (
		!parsed ||
		parsed.origin !== url.replace(/\/$/, '') ||
		!(parsed.protocol === 'https:' || (local && parsed.protocol === 'http:'))
	) {
		console.error(
			'Dashboard login is off: DASHBOARD_URL must be an https origin, like https://shrimp-fried-rice.alexle.dev (http only on 127.0.0.1 or localhost), with no path.',
		);
		return null;
	}
	return { clientId, clientSecret, origin: parsed.origin };
}

export function redirectUri(config: AuthConfig): string {
	return `${config.origin}/auth/callback`;
}

/** Discord's consent page, which sends the visitor back to /auth/callback with a code and this state. */
export function authorizeUrl(config: AuthConfig, state: string): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: config.clientId,
		scope: 'identify',
		state,
		redirect_uri: redirectUri(config),
	});
	return `https://discord.com/oauth2/authorize?${params}`;
}

function basicAuth(config: AuthConfig): string {
	return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
}

async function discordError(what: string, response: Response): Promise<Error> {
	if (response.status === 429) {
		// Seconds, possibly fractional (Discord's rate limit docs).
		const seconds = Number(response.headers.get('retry-after'));
		return new DiscordRateLimitedError(seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS);
	}
	const detail = await response.text().catch(() => '');
	return new Error(`${what}: HTTP ${response.status} ${detail.slice(0, 200)}`.trim());
}

/**
 * Who logged in, from the code Discord gave /auth/callback. Discord's access
 * token is used once, for /users/@me, then revoked: the dashboard keeps its
 * own session and never acts as the user on Discord.
 */
export async function discordUserFromCode(config: AuthConfig, code: string, fetchFn: Fetch): Promise<DiscordUser> {
	const tokenResponse = await fetchFn(`${DISCORD_API}/oauth2/token`, {
		method: 'POST',
		headers: { Authorization: basicAuth(config), 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(config) }),
		signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
	});
	if (!tokenResponse.ok) throw await discordError('Discord refused the login code', tokenResponse);
	const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: unknown };
	if (typeof accessToken !== 'string') throw new Error("Discord's token response had no access_token");

	try {
		const userResponse = await fetchFn(`${DISCORD_API}/users/@me`, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
		});
		if (!userResponse.ok) throw await discordError("Discord didn't say who logged in", userResponse);
		const user = (await userResponse.json()) as { id?: unknown; username?: unknown; global_name?: unknown };
		if (typeof user.id !== 'string' || typeof user.username !== 'string') {
			throw new Error("Discord's user had no id or username");
		}
		return { id: user.id, name: typeof user.global_name === 'string' ? user.global_name : user.username };
	} finally {
		await revokeToken(config, accessToken, fetchFn);
	}
}

/** Best effort: a token left unrevoked expires on its own, so a failure is only logged. */
async function revokeToken(config: AuthConfig, token: string, fetchFn: Fetch): Promise<void> {
	try {
		const response = await fetchFn(`${DISCORD_API}/oauth2/token/revoke`, {
			method: 'POST',
			headers: { Authorization: basicAuth(config), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
			signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
		});
		if (!response.ok)
			console.error((await discordError("Couldn't revoke a dashboard login's Discord token", response)).message);
	} catch (error) {
		console.error("Couldn't revoke a dashboard login's Discord token:", error);
	}
}
