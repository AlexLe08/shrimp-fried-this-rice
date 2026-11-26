import { describe, expect, it, vi } from 'vitest';
import type { LinkReportOutcome } from '../../../src/minecraft/bridge/botClient.ts';
import type { LinkReport } from '../../../src/minecraft/bridge/bridge.ts';
import { NO_ANSWER, REFUSED, createLinkReporter } from '../../../src/minecraft/bridge/linkReports.ts';
import type { ChatStyle } from '../../../src/minecraft/bridge/toMinecraft.ts';

const STEVE: LinkReport = { player: 'Steve', code: '123456', uuid: undefined, onlineMode: true };

function setup(report: (link: LinkReport) => Promise<LinkReportOutcome>, tells = true) {
	const tell = vi.fn<(player: string, text: string, style: ChatStyle) => boolean>(() => tells);
	const log = vi.fn();
	let style: ChatStyle = { prefix: '[Discord]', colour: 'gold' };
	const reportLink = createLinkReporter({ report: vi.fn(report), tell, style: () => style, log });
	return { reportLink, tell, log, setStyle: (next: ChatStyle) => (style = next) };
}

describe('createLinkReporter', () => {
	it("shows the player the bot's answer, in the bridge's style when it answers", async () => {
		let answer!: (value: LinkReportOutcome) => void;
		const { reportLink, tell, log, setStyle } = setup(() => new Promise((resolve) => (answer = resolve)));

		const done = reportLink(STEVE);
		setStyle({ prefix: '(DC)', colour: 'aqua' });
		answer({ kind: 'answered', result: 'linked', text: 'Linked Steve.' });
		await done;

		expect(tell).toHaveBeenCalledExactlyOnceWith('Steve', 'Linked Steve.', { prefix: '(DC)', colour: 'aqua' });
		expect(log).toHaveBeenCalledWith("Steve's !link: linked");
	});

	it('answers for the bot when it gave none, or the report threw', async () => {
		const none = setup(() => Promise.resolve({ kind: 'no-answer' }));
		await none.reportLink(STEVE);
		expect(none.tell).toHaveBeenCalledWith('Steve', NO_ANSWER, expect.anything());

		const threw = setup(() => Promise.reject(new Error('boom')));
		await expect(threw.reportLink(STEVE)).resolves.toBeUndefined();
		expect(threw.tell).toHaveBeenCalledWith('Steve', NO_ANSWER, expect.anything());
		expect(threw.log).toHaveBeenCalledWith("checking Steve's !link failed: boom");
	});

	it("says the server's mcbridge needs its owner when the bot no longer takes it, not to try again", async () => {
		const { reportLink, tell } = setup(() => Promise.resolve({ kind: 'refused' }));

		await reportLink(STEVE);

		expect(tell).toHaveBeenCalledWith('Steve', REFUSED, expect.anything());
	});

	it('says nothing while the helper is stopping, as a restart is no failure', async () => {
		const { reportLink, tell } = setup(() => Promise.resolve({ kind: 'stopping' }));

		await reportLink(STEVE);

		expect(tell).not.toHaveBeenCalled();
	});

	it("logs when the answer can't go into the game", async () => {
		const { reportLink, log } = setup(
			() => Promise.resolve({ kind: 'answered', result: 'linked', text: 'Linked.' }),
			false,
		);

		await reportLink(STEVE);

		expect(log).toHaveBeenCalledWith("couldn't answer Steve in game: two-way chat is off or the server is down");
	});
});
