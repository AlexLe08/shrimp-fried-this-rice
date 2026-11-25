import { vi } from 'vitest';
import type {
	BridgePairing,
	ChannelChoice,
	PairAnswer,
	RegenerateAnswer,
	RemoveAnswer,
} from '../../src/minecraft/dashboardPairing.ts';
import { helperConfig } from '../../src/minecraft/pairing.ts';
import { createBridge, deleteBridge, getBridge, replaceBridgeConnection } from '../../src/minecraft/storage.ts';

type Mocked<K extends keyof BridgePairing> = ReturnType<typeof vi.fn<BridgePairing[K]>>;

/**
 * Pairing as the dashboard sees it. By default it offers `choices`, and pairs,
 * regenerates and removes by changing the bridge as the real one would
 * (webhooks aside); `answer`, `regenerateAnswer` and `removeAnswer` make each
 * refuse instead, and `undeleted` names old webhooks Discord kept.
 */
export function fakePairing(
	options: {
		choices?: ChannelChoice[] | null;
		answer?: PairAnswer;
		regenerateAnswer?: RegenerateAnswer;
		removeAnswer?: RemoveAnswer;
		undeleted?: { channelId: string; webhookId: string }[];
	} = {},
): BridgePairing & { pair: Mocked<'pair'>; regenerate: Mocked<'regenerate'>; remove: Mocked<'remove'> } {
	const choices = options.choices === undefined ? [{ id: 'c1', name: 'general' }] : options.choices;
	const undeletedWebhooks = options.undeleted ?? [];
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
		regenerate: vi.fn<BridgePairing['regenerate']>(async (request) => {
			if (options.regenerateAnswer) return options.regenerateAnswer;
			const old = getBridge(request.bridgeId);
			if (!old || old.guild_id !== request.guildId) return { ok: false, reason: 'unknown-bridge' };
			replaceBridgeConnection(old.id, {
				chat: { channelId: old.chat_channel_id, webhookId: '903', token: 'tok-chat-2' },
				alerts: { channelId: old.alerts_channel_id, webhookId: '904', token: 'tok-alerts-2' },
				keys: { request: Buffer.alloc(32, 3), response: Buffer.alloc(32, 4) },
			});
			const bridge = getBridge(old.id)!;
			return {
				ok: true,
				bridge,
				config: helperConfig(bridge, 'the-new-secret', request.dashboardUrl),
				undeletedWebhooks,
			};
		}),
		remove: vi.fn<BridgePairing['remove']>(async (request) => {
			if (options.removeAnswer) return options.removeAnswer;
			const bridge = getBridge(request.bridgeId);
			if (!bridge || bridge.guild_id !== request.guildId) return { ok: false, reason: 'unknown-bridge' };
			deleteBridge(bridge.id);
			return { ok: true, bridge, undeletedWebhooks };
		}),
	};
}
