import { randomBytes } from 'node:crypto';

// One-time tokens for forms whose answer can't be repeated: pairing shows a
// secret only in its POST's response, so the page can't redirect after it,
// and a reload ("resubmit the form?") or a double click would pair again.
// Each form carries a token, used up before its POST does anything.

export const FORM_TOKEN_LIFETIME_MS = 30 * 60_000;
/** Kept in memory, so a restart forgets them and the form is loaded again. */
export const MAX_FORM_TOKENS = 10_000;

export interface FormTokens {
	/** A new token for this form (the key names the form and who it's for). */
	issue(key: string): string;
	/** True once, for a live token issued under the same key; used up either way. */
	take(token: string, key: string): boolean;
}

export function createFormTokens(now: () => number = Date.now): FormTokens {
	// In issue order, so the first entries are the oldest.
	const tokens = new Map<string, { key: string; expiresAt: number }>();
	return {
		issue(key) {
			const time = now();
			for (const [token, entry] of tokens) {
				if (entry.expiresAt > time && tokens.size < MAX_FORM_TOKENS) break;
				tokens.delete(token);
			}
			const token = randomBytes(16).toString('base64url');
			tokens.set(token, { key, expiresAt: time + FORM_TOKEN_LIFETIME_MS });
			return token;
		},
		take(token, key) {
			const entry = tokens.get(token);
			if (!entry) return false;
			tokens.delete(token);
			return entry.key === key && entry.expiresAt > now();
		},
	};
}
