import type { BridgeEvent } from './classify.ts';

type Alert = Extract<BridgeEvent, { type: 'alert' }>;

/** An alert cleared to post. */
export interface GatedAlert {
	alert: Alert;
	/**
	 * Copies of this alert held back since it last posted. For lag, a copy is
	 * one crossing of the threshold (`lagThreshold` warnings), not one warning.
	 */
	repeats: number;
	/** Alerts of any kind dropped by the per-minute cap since the last post. */
	capped: number;
}

export interface AlertGateOptions {
	/** How many lag warnings within `lagWindowMs` make one alert. */
	lagThreshold: number;
	lagWindowMs: number;
	/** The same message again within this long is counted, not posted. */
	dedupeWindowMs: number;
	/** At most this many alerts post per minute; the rest are counted. Crashes are never held back by it. */
	maxPerMinute: number;
}

// The owner's server logs "Can't keep up!" in pairs every 5 to 10 minutes as
// a matter of course, so a pair alone is not worth a ping.
export const DEFAULT_ALERT_GATE: AlertGateOptions = {
	lagThreshold: 5,
	lagWindowMs: 5 * 60_000,
	dedupeWindowMs: 10 * 60_000,
	maxPerMinute: 5,
};

export interface AlertGate {
	/** The alert to post now, or null to hold it back. `now` is in milliseconds. */
	check(alert: Alert, now: number): GatedAlert | null;
	/**
	 * Alerts whose de-duplication window has ended with copies held back, so a
	 * burst that stops still gets its count posted, and the count of alerts the
	 * cap dropped with nothing posted after them. The caller runs this every so
	 * often and posts the result as one message; each count is returned once.
	 */
	summaries(now: number): { repeated: GatedAlert[]; capped: number };
}

/** Numbers (ticks behind, entity ids, coordinates) vary between otherwise identical messages. */
function normalise(text: string): string {
	return text.replace(/\d+/g, '#');
}

// Vanilla's catch-all `Encountered an unexpected exception` covers any error,
// so the first stack trace line (the exception and its message) tells two apart.
function dedupeKey(alert: Alert): string {
	const firstDetail = alert.details.find((line) => line.trim() !== '') ?? '';
	return `${alert.kind}:${normalise(alert.message)}:${normalise(firstDetail)}`;
}

export function createAlertGate(options: AlertGateOptions = DEFAULT_ALERT_GATE): AlertGate {
	let lagTimes: number[] = [];
	let postedTimes: number[] = [];
	let cappedSincePost = 0;
	// Per normalised message: the alert that last posted, when, and how many were held back since.
	const seen = new Map<string, { alert: Alert; postedAt: number; suppressed: number }>();

	return {
		check(alert, now) {
			if (alert.kind === 'lag') {
				lagTimes = lagTimes.filter((time) => now - time < options.lagWindowMs);
				lagTimes.push(now);
				if (lagTimes.length < options.lagThreshold) return null;
				lagTimes = [];
			}

			const key = dedupeKey(alert);
			const previous = seen.get(key);
			if (previous && now - previous.postedAt < options.dedupeWindowMs) {
				previous.suppressed++;
				return null;
			}

			postedTimes = postedTimes.filter((time) => now - time < 60_000);
			// A crash follows a burst of the log's own errors, which can fill the
			// minute's quota just before the report is picked up; it's the one
			// alert that mustn't become a count. Restarts already space crashes
			// out, and copies are still held back above.
			if (alert.kind !== 'crash' && postedTimes.length >= options.maxPerMinute) {
				cappedSincePost++;
				return null;
			}
			postedTimes.push(now);

			const gated = { alert, repeats: previous?.suppressed ?? 0, capped: cappedSincePost };
			cappedSincePost = 0;
			seen.set(key, { alert, postedAt: now, suppressed: 0 });
			return gated;
		},
		summaries(now) {
			const repeated: GatedAlert[] = [];
			// Deleting expired entries also keeps the map from growing with every
			// distinct error for as long as the helper runs.
			for (const [key, entry] of seen) {
				if (now - entry.postedAt < options.dedupeWindowMs) continue;
				seen.delete(key);
				if (entry.suppressed > 0) repeated.push({ alert: entry.alert, repeats: entry.suppressed, capped: 0 });
			}
			const capped = cappedSincePost;
			cappedSincePost = 0;
			return { repeated, capped };
		},
	};
}
