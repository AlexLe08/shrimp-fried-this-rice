import type { LinkReportOutcome } from './botClient.ts';
import type { LinkReport } from './bridge.ts';
import type { ChatStyle } from './toMinecraft.ts';

// A player's `!link` line, once paired (decision 0007; the plan's A8,
// "Linking a Discord member to a Minecraft player"): sent to the bot, which
// checks the code and words the answer, and the answer shown to that player
// alone. The line itself never reaches Discord (bridge.ts).

// The only lines the helper words itself, for when the bot gave no answer.
/** The bot couldn't be reached in time: the player may try again. */
export const NO_ANSWER =
	"mcbridge couldn't check your code with the bot just now. Try again in a few minutes, or get a new code if it has run out.";
/** The bot no longer takes this helper: trying again won't help until its owner acts, and they've had an alert. */
export const REFUSED =
	"This server's mcbridge isn't connected to the bot right now, so codes can't be checked. The server's owner has been told.";

export interface LinkReporterOptions {
	report(link: LinkReport): Promise<LinkReportOutcome>;
	/** gameRelay.ts's tell: false when it can't go in. */
	tell(player: string, text: string, style: ChatStyle): boolean;
	/** The bridge's style at the time of answering, as the dashboard may have changed it. */
	style(): ChatStyle;
	log: (message: string) => void;
}

export function createLinkReporter(options: LinkReporterOptions): (link: LinkReport) => Promise<void> {
	return async (link) => {
		let outcome: LinkReportOutcome;
		try {
			outcome = await options.report(link);
		} catch (error) {
			// Never an unhandled rejection: that would end the helper, one-way relay and all.
			options.log(`checking ${link.player}'s !link failed: ${(error as Error).message}`);
			outcome = { kind: 'no-answer' };
		}
		let text: string;
		switch (outcome.kind) {
			// A restart isn't a failure to report to the player.
			case 'stopping':
				return;
			case 'answered':
				options.log(`${link.player}'s !link: ${outcome.result}`);
				text = outcome.text;
				break;
			case 'refused':
				text = REFUSED;
				break;
			case 'no-answer':
				text = NO_ANSWER;
				break;
		}
		// The link may well be saved even so: only the answer is lost.
		if (!options.tell(link.player, text, options.style())) {
			options.log(`couldn't answer ${link.player} in game: two-way chat is off or the server is down`);
		}
	};
}
