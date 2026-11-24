import { isIPv4, isIPv6 } from 'node:net';

// Far above what someone reading a few pages sends, even several people
// behind one address; the dashboard's pages load nothing else.
export const VISITOR_REQUESTS_PER_MINUTE = 60;
// Each login calls Discord from the IP the bot shares (loginGate.ts), and
// each new account it signs in adds Discord calls for access checks
// (decision 0012), so one visitor gets a few, not the whole dashboard's cap.
export const VISITOR_LOGINS_PER_WINDOW = 5;
export const VISITOR_LOGIN_WINDOW_MS = 10 * 60_000;
// Across all of one account's sessions and addresses, for the pages that
// may ask Discord about its servers.
export const USER_REQUESTS_PER_MINUTE = 30;
export const MINUTE_MS = 60_000;

// Bounds memory when many addresses appear at once; past it, new keys share
// one bucket, so a flood of addresses slows only the newcomers among them.
export const MAX_KEYS = 10_000;
const OVERFLOW_KEY = 'overflow';
// Shared by every request with no usable address: stricter, never looser.
const UNKNOWN_VISITOR = 'unknown';

export interface RateLimiter {
	/** Counts one request for `key`: 0 if allowed, else the milliseconds until its window resets. */
	take(key: string): number;
}

export function createRateLimiter(limit: number, windowMs: number, now: () => number): RateLimiter {
	const windows = new Map<string, { start: number; count: number }>();
	let lastSweep = -Infinity;

	function sweep(time: number): void {
		lastSweep = time;
		for (const [key, window] of windows) if (time - window.start >= windowMs) windows.delete(key);
	}

	return {
		take(requested) {
			const time = now();
			if (time - lastSweep >= windowMs) sweep(time);
			let key = requested;
			if (!windows.has(key) && windows.size >= MAX_KEYS) {
				sweep(time);
				if (windows.size >= MAX_KEYS) key = OVERFLOW_KEY;
			}
			let window = windows.get(key);
			if (!window || time - window.start >= windowMs) {
				window = { start: time, count: 0 };
				windows.set(key, window);
			}
			if (window.count >= limit) return window.start + windowMs - time;
			window.count++;
			return 0;
		},
	};
}

/**
 * The visitor's key from Cloudflare's CF-Connecting-IP header, which can be
 * trusted only because the server listens on 127.0.0.1 and only cloudflared
 * reaches it (decisions 0008 and 0009). An IPv6 address counts by its /64,
 * the block one home or server is usually given, so cycling through its
 * addresses doesn't buy more requests.
 */
export function visitorKey(header: string | undefined): string {
	const address = header?.trim() ?? '';
	if (isIPv4(address)) return address;
	if (!isIPv6(address)) return UNKNOWN_VISITOR;
	// URL's serializer canonicalizes it: lower case, hex only, the longest run of zero groups as `::`.
	const host = URL.parse(`http://[${address}]/`)?.hostname.slice(1, -1);
	if (!host) return UNKNOWN_VISITOR;
	const [head = '', tail] = host.split('::');
	const headGroups = head ? head.split(':') : [];
	const tailGroups = tail ? tail.split(':') : [];
	const zeros = tail === undefined ? [] : Array<string>(8 - headGroups.length - tailGroups.length).fill('0');
	return `${[...headGroups, ...zeros, ...tailGroups].slice(0, 4).join(':')}::/64`;
}
