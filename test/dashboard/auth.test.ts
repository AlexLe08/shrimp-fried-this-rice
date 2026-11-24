import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
	DiscordRateLimitedError,
	authConfigFromEnv,
	authorizeUrl,
	discordUserFromCode,
	type AuthConfig,
	type Fetch,
} from '../../src/dashboard/auth.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

const config: AuthConfig = { clientId: 'client-1', clientSecret: 'secret-1', origin: 'https://dash.example' };

function quietErrors(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** A fake fetch answering Discord's token, user and revoke endpoints. */
function fakeDiscord(overrides: { token?: Response; user?: Response; revoke?: Response | Error } = {}): Mock<Fetch> {
	return vi.fn<Fetch>(async (input) => {
		const url = String(input);
		if (url.endsWith('/oauth2/token')) {
			return overrides.token ?? Response.json({ access_token: 'access-1', token_type: 'Bearer' });
		}
		if (url.endsWith('/users/@me')) {
			return overrides.user ?? Response.json({ id: 'u1', username: 'alex', global_name: 'Alex' });
		}
		if (url.endsWith('/oauth2/token/revoke')) {
			if (overrides.revoke instanceof Error) throw overrides.revoke;
			return overrides.revoke ?? new Response(null, { status: 200 });
		}
		throw new Error(`unexpected ${url}`);
	});
}

describe('authConfigFromEnv', () => {
	const env = {
		DISCORD_CLIENT_ID: 'client-1',
		DISCORD_CLIENT_SECRET: 'secret-1',
		DASHBOARD_URL: 'https://shrimp-fried-rice.alexle.dev',
	};

	it('reads the client and the public origin', () => {
		expect(authConfigFromEnv(env)).toEqual({
			clientId: 'client-1',
			clientSecret: 'secret-1',
			origin: 'https://shrimp-fried-rice.alexle.dev',
		});
		expect(authConfigFromEnv({ ...env, DASHBOARD_URL: 'https://shrimp-fried-rice.alexle.dev/' })?.origin).toBe(
			'https://shrimp-fried-rice.alexle.dev',
		);
	});

	it('allows plain http only on this machine', () => {
		quietErrors();

		expect(authConfigFromEnv({ ...env, DASHBOARD_URL: 'http://127.0.0.1:8787' })?.origin).toBe('http://127.0.0.1:8787');
		expect(authConfigFromEnv({ ...env, DASHBOARD_URL: 'http://localhost:8787' })?.origin).toBe('http://localhost:8787');
		expect(authConfigFromEnv({ ...env, DASHBOARD_URL: 'http://shrimp-fried-rice.alexle.dev' })).toBeNull();
	});

	it('is off, silently, when neither the secret nor the URL is set (a dev bot)', () => {
		const error = quietErrors();

		expect(authConfigFromEnv({ DISCORD_CLIENT_ID: 'client-1' })).toBeNull();
		expect(error).not.toHaveBeenCalled();
	});

	it.each([
		[{ ...env, DISCORD_CLIENT_SECRET: undefined }],
		[{ ...env, DASHBOARD_URL: undefined }],
		[{ ...env, DISCORD_CLIENT_ID: undefined }],
	])('is off, logging why, when one is missing (%#)', (partial) => {
		const error = quietErrors();

		expect(authConfigFromEnv(partial)).toBeNull();
		expect(error).toHaveBeenCalledWith(expect.stringContaining('DISCORD_CLIENT_SECRET'));
	});

	it.each(['not a url', 'https://dash.example/path', 'https://dash.example?x=1', 'ftp://dash.example'])(
		'is off, logging why, for a DASHBOARD_URL that is not an origin: %j',
		(url) => {
			const error = quietErrors();

			expect(authConfigFromEnv({ ...env, DASHBOARD_URL: url })).toBeNull();
			expect(error).toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_URL'));
		},
	);
});

describe('authorizeUrl', () => {
	it("sends the visitor to Discord's consent page for identify only, with the state and callback", () => {
		const url = new URL(authorizeUrl(config, 'state-1'));

		expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			response_type: 'code',
			client_id: 'client-1',
			scope: 'identify',
			state: 'state-1',
			redirect_uri: 'https://dash.example/auth/callback',
		});
	});
});

describe('discordUserFromCode', () => {
	it('exchanges the code, reads the user, and revokes the token', async () => {
		const fetchFn = fakeDiscord();

		await expect(discordUserFromCode(config, 'code-1', fetchFn)).resolves.toEqual({ id: 'u1', name: 'Alex' });

		const [tokenUrl, tokenInit] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(tokenUrl).toBe('https://discord.com/api/v10/oauth2/token');
		expect(tokenInit.method).toBe('POST');
		expect((tokenInit.headers as Record<string, string>)['Authorization']).toBe(
			`Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
		);
		expect(Object.fromEntries(tokenInit.body as URLSearchParams)).toEqual({
			grant_type: 'authorization_code',
			code: 'code-1',
			redirect_uri: 'https://dash.example/auth/callback',
		});
		const [, userInit] = fetchFn.mock.calls[1] as [string, RequestInit];
		expect((userInit.headers as Record<string, string>)['Authorization']).toBe('Bearer access-1');
		const [revokeUrl, revokeInit] = fetchFn.mock.calls[2] as [string, RequestInit];
		expect(revokeUrl).toBe('https://discord.com/api/v10/oauth2/token/revoke');
		expect(Object.fromEntries(revokeInit.body as URLSearchParams)).toEqual({
			token: 'access-1',
			token_type_hint: 'access_token',
		});
	});

	it('names the user by username when no display name is set', async () => {
		const fetchFn = fakeDiscord({ user: Response.json({ id: 'u1', username: 'alex', global_name: null }) });

		await expect(discordUserFromCode(config, 'code-1', fetchFn)).resolves.toEqual({ id: 'u1', name: 'alex' });
	});

	it('throws when Discord refuses the code, without asking for the user', async () => {
		const fetchFn = fakeDiscord({ token: new Response('{"error":"invalid_grant"}', { status: 400 }) });

		await expect(discordUserFromCode(config, 'code-1', fetchFn)).rejects.toThrow(
			'Discord refused the login code: HTTP 400 {"error":"invalid_grant"}',
		);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("throws a rate-limit error carrying Discord's Retry-After on a 429", async () => {
		const limited = (headers: Record<string, string>) =>
			fakeDiscord({ token: new Response('{"retry_after": 2.5}', { status: 429, headers }) });

		const error = await discordUserFromCode(config, 'code-1', limited({ 'Retry-After': '2.5' })).catch((e) => e);
		expect(error).toBeInstanceOf(DiscordRateLimitedError);
		expect((error as DiscordRateLimitedError).retryAfterMs).toBe(2500);

		const withoutHeader = await discordUserFromCode(config, 'code-1', limited({})).catch((e) => e);
		expect((withoutHeader as DiscordRateLimitedError).retryAfterMs).toBe(60_000);
	});

	it('throws on a token response without an access token', async () => {
		const fetchFn = fakeDiscord({ token: Response.json({}) });

		await expect(discordUserFromCode(config, 'code-1', fetchFn)).rejects.toThrow('no access_token');
	});

	it('still revokes the token when reading the user fails', async () => {
		const fetchFn = fakeDiscord({ user: new Response('nope', { status: 500 }) });

		await expect(discordUserFromCode(config, 'code-1', fetchFn)).rejects.toThrow(
			"Discord didn't say who logged in: HTTP 500 nope",
		);
		expect(fetchFn.mock.calls.map(([url]) => url as string).at(-1)).toMatch(/revoke$/);
	});

	it('throws on a user without an id', async () => {
		const fetchFn = fakeDiscord({ user: Response.json({ username: 'alex' }) });

		await expect(discordUserFromCode(config, 'code-1', fetchFn)).rejects.toThrow('no id or username');
	});

	it('logs, and still returns the user, when revoking fails', async () => {
		const error = quietErrors();

		await expect(
			discordUserFromCode(config, 'code-1', fakeDiscord({ revoke: new Response('', { status: 503 }) })),
		).resolves.toEqual({ id: 'u1', name: 'Alex' });
		await expect(
			discordUserFromCode(config, 'code-1', fakeDiscord({ revoke: new Error('network down') })),
		).resolves.toEqual({ id: 'u1', name: 'Alex' });
		expect(error).toHaveBeenCalledTimes(2);
	});
});
