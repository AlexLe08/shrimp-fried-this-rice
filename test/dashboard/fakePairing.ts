import { vi } from 'vitest';
import type { BridgePairing, ChannelChoice, PairAnswer } from '../../src/minecraft/dashboardPairing.ts';
import { helperConfig } from '../../src/minecraft/pairing.ts';
import { createBridge } from '../../src/minecraft/storage.ts';

/**
 * Pairing as the dashboard sees it. By default it offers `choices` and pairs
 * by saving a bridge as the real one would (webhooks aside); `answer` makes
 * it refuse instead.
 */
export function fakePairing(
	options: { choices?: ChannelChoice[] | null; answer?: PairAnswer } = {},
): BridgePairing & { pair: ReturnType<typeof vi.fn<BridgePairing['pair']>> } {
	const choices = options.choices === undefined ? [{ id: 'c1', name: 'general' }] : options.choices;
	return {
		channelChoices: vi.fn(async () => choices),
		pair: vi.fn<BridgePairing['pair']>(async (request) => {
			if (options.answer) return options.answer;
			const bridge = createBridge({
				guildId: request.guildId,
				chat: { channelId: request.chatChannelId, webhookId: '901', token: 'tok-chat' },
				alerts: { channelId: request.alertsChannelId, webhookId: '902', token: 'tok-alerts' },
				keys: { request: Buffer.alloc(32, 1), response: Buffer.alloc(32, 2) },
				serverName: request.serverName,
				now: 1,
			});
			return { ok: true, bridge, config: helperConfig(bridge, 'the-secret', request.dashboardUrl) };
		}),
	};
}
