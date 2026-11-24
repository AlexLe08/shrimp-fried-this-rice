// Logins call Discord from the VM's own IP, which the bot shares: enough
// refused requests (401, 403, 429) get that IP blocked from Discord's API,
// reminders and commands included. Anyone can start logins, so this caps
// them for the whole dashboard, whoever sends them, well below that limit.
export const LOGINS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

export interface LoginGate {
	/** Takes one of this minute's logins; false when they're used up or Discord has asked to wait. */
	tryTake(): boolean;
	/** After Discord's 429: no logins until its Retry-After has passed. */
	blockFor(ms: number): void;
}

export function createLoginGate(now: () => number): LoginGate {
	let windowStart = -Infinity;
	let taken = 0;
	let blockedUntil = 0;
	return {
		tryTake() {
			const time = now();
			if (time < blockedUntil) return false;
			if (time - windowStart >= MINUTE_MS) {
				windowStart = time;
				taken = 0;
			}
			if (taken >= LOGINS_PER_MINUTE) return false;
			taken++;
			return true;
		},
		blockFor(ms) {
			blockedUntil = Math.max(blockedUntil, now() + ms);
		},
	};
}
