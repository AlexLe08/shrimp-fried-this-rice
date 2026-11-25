import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDashboard, stopDashboard } from '../../../src/dashboard/server.ts';
import readyEvent from '../../../src/minecraft/events/ready.ts';
import { HelperHub } from '../../../src/minecraft/helperHub.ts';

// Mocked, so this file is only about the wiring; catchUp.test.ts covers the rest.
vi.mock('../../../src/minecraft/catchUp.ts', () => ({ catchUpBridges: vi.fn(() => Promise.resolve()) }));
const { catchUpBridges } = await import('../../../src/minecraft/catchUp.ts');

afterEach(async () => {
	await stopDashboard();
	vi.mocked(catchUpBridges).mockClear();
});

describe('ready event (Minecraft catch-up)', () => {
	it("catches up once ready, through the running dashboard's hub", async () => {
		const hub = new HelperHub();
		await startDashboard(0, { auth: null, helpers: hub });
		const client = { user: { tag: 'bot#0001' } };

		await readyEvent.execute(client as never);

		expect(readyEvent.once).toBe(true);
		expect(catchUpBridges).toHaveBeenCalledExactlyOnceWith(client, hub);
	});

	it('passes no hub while the dashboard is off, so nothing is caught up', async () => {
		await readyEvent.execute({} as never);

		expect(catchUpBridges).toHaveBeenCalledExactlyOnceWith({}, null);
	});
});
