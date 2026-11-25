import type { LinkAnswer } from './botClient.ts';
import type { LinkReport } from './bridge.ts';
import type { ChatStyle } from './toMinecraft.ts';

// A player's `!link` line, once paired (decision 0007; the plan's A8,
// "Linking a Discord member to a Minecraft player"): sent to the bot, which
// checks the code and words the answer, and the answer shown to that player
// alone. The line itself never reaches Discord (bridge.ts).

/** Shown when the bot gave no answer: the one line the helper words itself. */
export const NO_ANSWER =
	"mcbridge couldn't check your code with the bot just now. Try again in a few minutes, or get a new code if it has run out.";

export interface LinkReporterOptions {
	report(link: LinkReport): Promise<LinkAnswer | null>;
	/** gameRelay.ts's tell: false when it can't go in. */
	tell(player: string, text: string, style: ChatStyle): boolean;
	/** The bridge's style at the time of answering, as the dashboard may have changed it. */
	style(): ChatStyle;
	log: (message: string) => void;
}

export function createLinkReporter(options: LinkReporterOptions): (link: LinkReport) => Promise<void> {
	return async (link) => {
		let answer: LinkAnswer | null;
		try {
			answer = await options.report(link);
		} catch (error) {
			// Never an unhandled rejection: that would end the helper, one-way relay and all.
			options.log(`checking ${link.player}'s !link failed: ${(error as Error).message}`);
			answer = null;
		}
		if (answer) options.log(`${link.player}'s !link: ${answer.result}`);
		// The link may well be saved even so: only the answer is lost.
		if (!options.tell(link.player, answer?.text ?? NO_ANSWER, options.style())) {
			options.log(`couldn't answer ${link.player} in game: two-way chat is off or the server is down`);
		}
	};
}
