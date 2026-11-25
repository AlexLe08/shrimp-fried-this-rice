import { describe, expect, it, vi } from 'vitest';
import type { LinkAnswer } from '../../../src/minecraft/bridge/botClient.ts';
import type { LinkReport } from '../../../src/minecraft/bridge/bridge.ts';
import { NO_ANSWER, createLinkReporter } from '../../../src/minecraft/bridge/linkReports.ts';
import type { ChatStyle } from '../../../src/minecraft/bridge/toMinecraft.ts';

const STEVE: LinkReport = { player: 'Steve', code: '123456', uuid: undefined, onlineMode: true };

function setup(report: (link: LinkReport) => Promise<LinkAnswer | null>, tells = true) {
	const tell = vi.fn<(player: string, text: string, style: ChatStyle) => boolean>(() => tells);
	const log = vi.fn();
	let style: ChatStyle = { prefix: '[Discord]', colour: 'gold' };
	const reportLink = createLinkReporter({ report: vi.fn(report), tell, style: () => style, log });
	return { reportLink, tell, log, setStyle: (next: ChatStyle) => (style = next) };
}

describe('createLinkReporter', () => {
	it("shows the player the bot's answer, in the bridge's style when it answers", async () => {
		let answer!: (value: LinkAnswer) => void;
		const { reportLink, tell, log, setStyle } = setup(() => new Promise((resolve) => (answer = resolve)));

		const done = reportLink(STEVE);
		setStyle({ prefix: '(DC)', colour: 'aqua' });
		answer({ result: 'linked', text: 'Linked Steve.' });
		await done;

		expect(tell).toHaveBeenCalledExactlyOnceWith('Steve', 'Linked Steve.', { prefix: '(DC)', colour: 'aqua' });
		expect(log).toHaveBeenCalledWith("Steve's !link: linked");
	});

	it('answers for the bot when it gave none, or the report threw', async () => {
		const none = setup(() => Promise.resolve(null));
		await none.reportLink(STEVE);
		expect(none.tell).toHaveBeenCalledWith('Steve', NO_ANSWER, expect.anything());

		const threw = setup(() => Promise.reject(new Error('boom')));
		await expect(threw.reportLink(STEVE)).resolves.toBeUndefined();
		expect(threw.tell).toHaveBeenCalledWith('Steve', NO_ANSWER, expect.anything());
		expect(threw.log).toHaveBeenCalledWith("checking Steve's !link failed: boom");
	});

	it("logs when the answer can't go into the game", async () => {
		const { reportLink, log } = setup(() => Promise.resolve({ result: 'linked', text: 'Linked.' }), false);

		await reportLink(STEVE);

		expect(log).toHaveBeenCalledWith("couldn't answer Steve in game: two-way chat is off or the server is down");
	});
});
