import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	KEEP_ALIVE_TIMEOUT_MS,
	__dashboardServerForTests,
	dashboardPortFromEnv,
	startDashboard,
	stopDashboard,
} from '../../src/dashboard/server.ts';

afterEach(async () => {
	await stopDashboard();
	vi.restoreAllMocks();
});

function quietLogs(): { error: ReturnType<typeof vi.spyOn> } {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	return { error: vi.spyOn(console, 'error').mockImplementation(() => {}) };
}

/** GET over a keep-alive agent, which leaves the connection open and idle afterwards. */
function getKeepAlive(port: number, agent: http.Agent): Promise<string> {
	return new Promise((resolve, reject) => {
		http
			.get({ host: '127.0.0.1', port, path: '/health', agent }, (response) => {
				let body = '';
				response.on('data', (chunk: Buffer) => (body += chunk.toString()));
				response.on('end', () => resolve(body));
			})
			.on('error', reject);
	});
}

describe('dashboardPortFromEnv', () => {
	it('is null when DASHBOARD_PORT is unset or empty, without logging', () => {
		const { error } = quietLogs();

		expect(dashboardPortFromEnv({})).toBeNull();
		expect(dashboardPortFromEnv({ DASHBOARD_PORT: '' })).toBeNull();
		expect(error).not.toHaveBeenCalled();
	});

	it('reads a port number', () => {
		expect(dashboardPortFromEnv({ DASHBOARD_PORT: '8787' })).toBe(8787);
		expect(dashboardPortFromEnv({ DASHBOARD_PORT: '1' })).toBe(1);
		expect(dashboardPortFromEnv({ DASHBOARD_PORT: '65535' })).toBe(65535);
	});

	it.each(['0', '65536', '-1', '80.5', ' 8787', '8787abc', 'abc', '1e3'])('refuses %j, logging why', (value) => {
		const { error } = quietLogs();

		expect(dashboardPortFromEnv({ DASHBOARD_PORT: value })).toBeNull();
		expect(error).toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_PORT'));
	});
});

describe('startDashboard', () => {
	it('serves the app on 127.0.0.1 only', async () => {
		quietLogs();
		const port = await startDashboard(0);

		expect(port).not.toBeNull();
		expect((__dashboardServerForTests()?.address() as AddressInfo).address).toBe('127.0.0.1');
		const response = await fetch(`http://127.0.0.1:${port}/health`);
		expect(await response.text()).toBe('ok');
	});

	it('keeps idle connections open longer than cloudflared does (90 s)', async () => {
		quietLogs();
		await startDashboard(0);

		expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(90_000);
		expect(__dashboardServerForTests()?.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
	});

	it("leaves the process's global Request and Response alone", async () => {
		quietLogs();
		const { Request, Response } = globalThis;
		await startDashboard(0);

		expect(globalThis.Request).toBe(Request);
		expect(globalThis.Response).toBe(Response);
	});

	it('resolves null and logs, rather than throwing, when the port is taken', async () => {
		const { error } = quietLogs();
		const other = net.createServer();
		await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
		const port = (other.address() as AddressInfo).port;

		const result = await startDashboard(port);

		expect(result).toBeNull();
		expect(error).toHaveBeenCalledWith('The dashboard is off: its server failed:', expect.anything());
		expect(__dashboardServerForTests()).toBeNull();
		await new Promise((resolve) => other.close(resolve));
	});

	it('resolves null and logs, rather than throwing, when the server throws as it starts', async () => {
		const { error } = quietLogs();

		await expect(startDashboard(70_000)).resolves.toBeNull();

		expect(error).toHaveBeenCalledWith('The dashboard is off: its server failed:', expect.any(RangeError));
		expect(__dashboardServerForTests()).toBeNull();
	});

	it('refuses to start a second server while one is running', async () => {
		const { error } = quietLogs();
		await startDashboard(0);
		const running = __dashboardServerForTests();

		await expect(startDashboard(0)).resolves.toBeNull();

		expect(error).toHaveBeenCalledWith(expect.stringContaining('already running'));
		expect(__dashboardServerForTests()).toBe(running);
	});
});

describe('stopDashboard', () => {
	it('does nothing when the dashboard was never started', async () => {
		await expect(stopDashboard()).resolves.toBeUndefined();
	});

	it("stops taking requests, without waiting on an idle keep-alive connection's timeout", async () => {
		quietLogs();
		const port = (await startDashboard(0))!;
		const agent = new http.Agent({ keepAlive: true });
		expect(await getKeepAlive(port, agent)).toBe('ok');

		const started = Date.now();
		await stopDashboard(60_000);

		expect(Date.now() - started).toBeLessThan(2000);
		expect(__dashboardServerForTests()).toBeNull();
		await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
		agent.destroy();
	});

	it('cuts off a request still under way once the grace period is over', async () => {
		quietLogs();
		const port = (await startDashboard(0))!;
		const client = net.connect(port, '127.0.0.1');
		await new Promise((resolve) => client.once('connect', resolve));
		const closed = new Promise((resolve) => client.once('close', resolve));
		// Headers never finished: the server counts it as a request under way.
		client.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
		await new Promise((resolve) => setTimeout(resolve, 50));

		const started = Date.now();
		await stopDashboard(100);

		expect(Date.now() - started).toBeLessThan(2000);
		await closed;
	});
});
