import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/dashboard/app.ts';

describe('dashboard app', () => {
	it('answers /health with ok', async () => {
		const response = await createApp().request('/health');

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('answers 404 for a path it has no route for', async () => {
		const response = await createApp().request('/nothing-here');

		expect(response.status).toBe(404);
	});
});
