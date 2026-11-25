import { randomInt } from 'node:crypto';
import { isMojangUuid } from './bridge/avatars.ts';
import { isPlayerName } from './bridge/settings.ts';
import { playerNameKey, saveLink } from './storage.ts';

// Linking a Discord member to a Minecraft player (decision 0007; the plan's
// A8, "Linking a Discord member to a Minecraft player"). A display name
// proves nothing, so the member proves it from both sides: the bot gives
// them a code, and they type it in game, where only that player can produce
// a chat line under their name. The helper reports the line; this checks it.

/** How long a code can be typed in game after it's given. */
export const LINK_CODE_TTL_MS = 10 * 60_000;
/**
 * Wrong codes reported for one name before every code for it is voided, so
 * a modified helper can't guess its way through a million codes.
 */
export const MAX_WRONG_TRIES = 5;

interface PendingName {
	/** By member: each member's latest code for the name. */
	codes: Map<string, { code: string; expiresAt: number }>;
	wrongTries: number;
}

export type CodeCheck =
	| { kind: 'right'; userId: string }
	/** `voided` once this was the last wrong try the name had. */
	| { kind: 'wrong'; voided: boolean }
	| { kind: 'none' };

/**
 * The codes given and not yet used. Memory only, as the plan has it: a
 * restart throws them away, and the member asks for a new one.
 */
export class LinkCodes {
	readonly #now: () => number;
	// Keyed by bridge, then the name compared without case.
	readonly #pending = new Map<string, PendingName>();

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/**
	 * A new code for the member to type as `name` on the bridge, replacing
	 * any they had for it. Other members' codes for the name are kept: asking
	 * for one mustn't void someone else's.
	 */
	issue(bridgeId: string, name: string, userId: string): string {
		this.#dropExpired();
		const key = pendingKey(bridgeId, name);
		let pending = this.#pending.get(key);
		if (!pending) {
			pending = { codes: new Map(), wrongTries: 0 };
			this.#pending.set(key, pending);
		}
		const taken = new Set([...pending.codes].filter(([user]) => user !== userId).map(([, held]) => held.code));
		let code: string;
		// Each code of a name belongs to one member, so a right one names who linked.
		do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
		while (taken.has(code));
		pending.codes.set(userId, { code, expiresAt: this.#now() + LINK_CODE_TTL_MS });
		return code;
	}

	/**
	 * Whose code this is for the name on the bridge. A right code is used up
	 * only with `use`, so one typed before the helper saw the player's login
	 * can be typed again after logging in. A wrong one counts towards voiding
	 * the name's codes.
	 */
	check(bridgeId: string, name: string, code: string, use: boolean): CodeCheck {
		this.#dropExpired();
		const key = pendingKey(bridgeId, name);
		const pending = this.#pending.get(key);
		if (!pending) return { kind: 'none' };
		for (const [userId, held] of pending.codes) {
			if (held.code !== code) continue;
			if (use) {
				pending.codes.delete(userId);
				if (pending.codes.size === 0) this.#pending.delete(key);
			}
			return { kind: 'right', userId };
		}
		pending.wrongTries++;
		if (pending.wrongTries < MAX_WRONG_TRIES) return { kind: 'wrong', voided: false };
		this.#pending.delete(key);
		return { kind: 'wrong', voided: true };
	}

	// Swept on every use: codes come from members asking, so there are few.
	#dropExpired(): void {
		const now = this.#now();
		for (const [key, pending] of this.#pending) {
			for (const [userId, held] of pending.codes) {
				if (held.expiresAt <= now) pending.codes.delete(userId);
			}
			if (pending.codes.size === 0) this.#pending.delete(key);
		}
	}
}

function pendingKey(bridgeId: string, name: string): string {
	return `${bridgeId}\n${playerNameKey(name)}`;
}

/** What the helper reports for a `!link` line (bridge.ts's LinkReport). */
export interface LinkReport {
	player: string;
	code: string;
	/** From this run's login line, if the helper saw it. */
	uuid?: string;
	onlineMode: boolean;
}

/** The report as sent, or null if it isn't one. */
export function readLinkReport(message: unknown): LinkReport | null {
	if (typeof message !== 'object' || message === null) return null;
	const { player, code, uuid, onlineMode } = message as Record<string, unknown>;
	if (!isPlayerName(player) || typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
	// Absent or null: the helper didn't see the login line.
	if (typeof onlineMode !== 'boolean' || (uuid != null && typeof uuid !== 'string')) return null;
	return { player, code, onlineMode, ...(typeof uuid === 'string' && { uuid }) };
}

export type LinkResult =
	'linked' | 'offline-mode' | 'no-code' | 'wrong-code' | 'voided' | 'log-in-again' | 'not-mojang';

/**
 * Checks a report against the codes given, and saves the link if it holds.
 * The answer's text is for the helper to show the player alone, written here
 * so its wording changes with a deploy rather than with every host's helper.
 */
export function answerLinkReport(
	codes: LinkCodes,
	bridgeId: string,
	report: LinkReport,
	now: number,
): { result: LinkResult; text: string } {
	const { player, code, uuid } = report;
	// Before the code: an offline-mode name is anyone's, whatever they type.
	if (!report.onlineMode) {
		return answer('offline-mode', "This server is in offline mode, so its players can't link a Discord account.");
	}
	const check = codes.check(bridgeId, player, code, false);
	if (check.kind === 'none') {
		return answer(
			'no-code',
			`There's no link code waiting for ${player}. Get one in the dashboard, then type it here.`,
		);
	}
	if (check.kind === 'wrong') {
		return check.voided
			? answer('voided', `Too many wrong codes for ${player}, so its codes no longer work. Get a new one.`)
			: answer('wrong-code', `That isn't the code given for ${player}. Check it, or get a new one.`);
	}
	// The link holds the UUID, so a name that changes hands doesn't carry it.
	if (uuid === undefined) {
		return answer('log-in-again', 'Log out and back in, then type the code again.');
	}
	if (!isMojangUuid(uuid)) {
		return answer('not-mojang', "This server didn't give your account's Mojang UUID, so it can't be linked.");
	}
	codes.check(bridgeId, player, code, true);
	saveLink({ bridgeId, name: player, userId: check.userId, uuid, now });
	return answer('linked', `Linked ${player} to your Discord account. Choose your picture in the dashboard.`);
}

function answer(result: LinkResult, text: string): { result: LinkResult; text: string } {
	return { result, text };
}
