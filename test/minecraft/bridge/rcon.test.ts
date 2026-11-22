import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	connectRcon,
	createRcon,
	MAX_COMMAND_BYTES,
	RconError,
	type ConnectOptions,
	type RconConnection,
	type RconOptions,
} from '../../../src/minecraft/bridge/rcon.ts';

const PASSWORD = 'hunter2';

interface Received {
	id: number;
	type: number;
	body: string;
}

// Framed by hand rather than with the module's encoder, so a framing bug
// can't pass by agreeing with itself.
function packet(id: number, type: number, body: string): Buffer {
	const payload = Buffer.from(body, 'latin1');
	const out = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
	out.writeInt32LE(out.length - 4, 0);
	out.writeInt32LE(id, 4);
	out.writeInt32LE(type, 8);
	payload.copy(out, 12);
	return out;
}

interface FakeOptions {
	/** What the server does with a command; by default it answers with an empty body, like `tellraw`. */
	onCommand?(socket: Socket, received: Received): void;
}

/** A Minecraft-like RCON server: type 3 logs in (answered as type 2, or id -1 for a wrong password). */
async function fakeServer(options: FakeOptions = {}) {
	const received: Received[] = [];
	const sockets = new Set<Socket>();
	let connections = 0;
	const server: Server = createServer((socket) => {
		connections++;
		sockets.add(socket);
		serverSockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		let buffered: Buffer = Buffer.alloc(0);
		let loggedIn = false;
		socket.on('data', (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readInt32LE(0)) {
				const length = buffered.readInt32LE(0);
				const message = {
					id: buffered.readInt32LE(4),
					type: buffered.readInt32LE(8),
					body: buffered.toString('latin1', 12, 4 + length - 2),
				};
				expect(buffered.subarray(4 + length - 2, 4 + length)).toEqual(Buffer.from([0, 0]));
				buffered = buffered.subarray(4 + length);
				received.push(message);
				if (message.type === 3) {
					loggedIn = message.body === PASSWORD;
					socket.write(packet(loggedIn ? message.id : -1, 2, ''));
				} else if (!loggedIn) {
					socket.write(packet(-1, 0, ''));
				} else if (options.onCommand) {
					options.onCommand(socket, message);
				} else {
					socket.write(packet(message.id, 0, ''));
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	servers.push(server);
	return {
		port,
		received,
		connections: () => connections,
		commands: () => received.filter((message) => message.type === 2).map((message) => message.body),
		/** Drops every open connection, as a server stopping or a network blip would. */
		dropAll() {
			for (const socket of sockets) socket.destroy();
		},
	};
}

const servers: Server[] = [];
// Destroyed after each test, so server.close() doesn't wait on a socket a test left open.
const serverSockets = new Set<Socket>();
const connections: RconConnection[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const connection of connections.splice(0)) connection.close();
	for (const socket of serverSockets) socket.destroy();
	serverSockets.clear();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

async function open(port: number, overrides: Partial<ConnectOptions> = {}) {
	const connection = await connectRcon({ host: '127.0.0.1', port, password: PASSWORD, timeoutMs: 500, ...overrides });
	connections.push(connection);
	return connection;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('connectRcon', () => {
	it('logs in with the password as a type 3 packet, then runs commands as type 2', async () => {
		const server = await fakeServer({
			onCommand: (socket, { id, body }) => socket.write(packet(id, 0, `ran ${body}`)),
		});
		const connection = await open(server.port);
		expect(await connection.command('time set 0')).toBe('ran time set 0');
		expect(server.received.map(({ type, body }) => [type, body])).toEqual([
			[3, PASSWORD],
			[2, 'time set 0'],
		]);
		expect(server.received[0]!.id).toBeGreaterThan(0);
		expect(server.received[1]!.id).not.toBe(server.received[0]!.id);
	});

	it('rejects a wrong password as login-refused', async () => {
		const server = await fakeServer();
		const failure = connectRcon({ host: '127.0.0.1', port: server.port, password: 'wrong', timeoutMs: 500 });
		await expect(failure).rejects.toMatchObject({ code: 'login-refused' });
	});

	it('rejects when nothing answers the login in time', async () => {
		const silent = createServer((socket) => {
			serverSockets.add(socket);
			socket.on('error', () => {});
		});
		await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
		servers.push(silent);
		const failure = connectRcon({
			host: '127.0.0.1',
			port: (silent.address() as AddressInfo).port,
			password: PASSWORD,
			timeoutMs: 50,
		});
		await expect(failure).rejects.toMatchObject({ code: 'timeout' });
	});

	it('rejects as closed when nothing listens on the port', async () => {
		const server = await fakeServer();
		const port = server.port;
		await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
		await expect(connectRcon({ host: '127.0.0.1', port, password: PASSWORD })).rejects.toMatchObject({
			code: 'closed',
		});
	});

	it('times a command out without closing the connection', async () => {
		let answer = false;
		const server = await fakeServer({
			onCommand: (socket, { id }) => {
				if (answer) socket.write(packet(id, 0, 'late'));
			},
		});
		const connection = await open(server.port, { timeoutMs: 50 });
		await expect(connection.command('say slow')).rejects.toMatchObject({ code: 'timeout' });
		answer = true;
		expect(await connection.command('say fast')).toBe('late');
	});

	it('rejects a command under way and calls onClose when the connection drops', async () => {
		const server = await fakeServer({ onCommand: (socket) => socket.destroy() });
		const onClose = vi.fn();
		const connection = await open(server.port, { onClose });
		await expect(connection.command('say hi')).rejects.toMatchObject({ code: 'closed' });
		expect(onClose).toHaveBeenCalledOnce();
		expect(onClose.mock.calls[0]![0]).toBeInstanceOf(RconError);
	});

	it('does not call onClose when closed on purpose', async () => {
		const server = await fakeServer();
		const onClose = vi.fn();
		const connection = await open(server.port, { onClose });
		connection.close();
		await expect(connection.command('say hi')).rejects.toMatchObject({ code: 'closed' });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onClose).not.toHaveBeenCalled();
	});

	it('reads packets split across reads and several in one read, ignoring later fragments', async () => {
		const server = await fakeServer({
			onCommand: (socket, { id, body }) => {
				const bytes = Buffer.concat([packet(id, 0, `first ${body}`), packet(id, 0, 'second fragment')]);
				// One byte at a time, then the next reply's bytes run on from the last fragment.
				for (const byte of bytes) socket.write(Buffer.from([byte]));
			},
		});
		const connection = await open(server.port);
		expect(await connection.command('one')).toBe('first one');
		expect(await connection.command('two')).toBe('first two');
	});

	it('decodes a reply as latin1, keeping a raw § byte', async () => {
		const server = await fakeServer({
			onCommand: (socket, { id }) => socket.write(packet(id, 0, '§aGreen')),
		});
		const connection = await open(server.port);
		expect(await connection.command('list')).toBe('§aGreen');
	});

	it('closes on a packet length no RCON server sends', async () => {
		const server = await fakeServer({
			onCommand: (socket) => socket.write(Buffer.from([0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0])),
		});
		const onClose = vi.fn();
		const connection = await open(server.port, { onClose });
		await expect(connection.command('say hi')).rejects.toMatchObject({ code: 'protocol' });
		expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 'protocol' }));
	});

	it('refuses a command that is not printable ASCII or is over the limit, without sending it', async () => {
		const server = await fakeServer();
		const connection = await open(server.port);
		expect(() => connection.command('say café')).toThrow(TypeError);
		expect(() => connection.command('say a\nb')).toThrow(TypeError);
		expect(() => connection.command('a'.repeat(MAX_COMMAND_BYTES + 1))).toThrow(RangeError);
		await connection.command('a'.repeat(MAX_COMMAND_BYTES));
		expect(server.commands()).toEqual(['a'.repeat(MAX_COMMAND_BYTES)]);
	});
});

describe('createRcon', () => {
	const logs: string[] = [];
	const setup = (port: number, overrides: Partial<RconOptions> = {}) => {
		logs.length = 0;
		const rcon = createRcon({
			host: '127.0.0.1',
			port,
			password: PASSWORD,
			timeoutMs: 300,
			minBackoffMs: 10,
			maxBackoffMs: 40,
			log: (message) => logs.push(message),
			...overrides,
		});
		return rcon;
	};

	it('sends nothing before start and after stop', async () => {
		const server = await fakeServer();
		const rcon = setup(server.port);
		expect(await rcon.send('say early')).toBe(false);
		rcon.start();
		expect(await rcon.send('say up')).toBe(true);
		rcon.stop();
		expect(await rcon.send('say late')).toBe(false);
		expect(server.commands()).toEqual(['say up']);
	});

	it('closes the connection on stop', async () => {
		const server = await fakeServer();
		const rcon = setup(server.port);
		rcon.start();
		await rcon.send('say hi');
		rcon.stop();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(server.connections()).toBe(1);
		expect(await rcon.send('say again')).toBe(false);
		expect(server.connections()).toBe(1);
	});

	it('reconnects after the connection drops', async () => {
		const server = await fakeServer();
		const rcon = setup(server.port);
		rcon.start();
		expect(await rcon.send('say one')).toBe(true);
		server.dropAll();
		await until(() => server.connections() === 2);
		expect(await rcon.send('say two')).toBe(true);
		expect(server.commands()).toEqual(['say one', 'say two']);
		rcon.stop();
	});

	it('retries a command cut off by a dropped connection once, on the next connection', async () => {
		let drops = 1;
		const server = await fakeServer({
			onCommand: (socket, { id }) => {
				if (drops-- > 0) socket.destroy();
				else socket.write(packet(id, 0, ''));
			},
		});
		const rcon = setup(server.port);
		rcon.start();
		expect(await rcon.send('say hi')).toBe(true);
		expect(server.commands()).toEqual(['say hi', 'say hi']);
		rcon.stop();
	});

	it('drops a command after its retry fails too', async () => {
		const server = await fakeServer({ onCommand: (socket) => socket.destroy() });
		const rcon = setup(server.port);
		rcon.start();
		expect(await rcon.send('say hi')).toBe(false);
		expect(server.commands()).toEqual(['say hi', 'say hi']);
		expect(logs.some((line) => line.startsWith('dropped an RCON command'))).toBe(true);
		rcon.stop();
	});

	it('does not resend a command that timed out, as a lagging server may still run it', async () => {
		const server = await fakeServer({ onCommand: () => {} });
		const rcon = setup(server.port, { timeoutMs: 50 });
		rcon.start();
		expect(await rcon.send('say hi')).toBe(false);
		expect(server.commands()).toEqual(['say hi']);
		rcon.stop();
	});

	it('stays off after a wrong password, calling onLoginRefused once', async () => {
		const server = await fakeServer();
		const onLoginRefused = vi.fn();
		const rcon = setup(server.port, { password: 'wrong', onLoginRefused });
		rcon.start();
		await until(() => onLoginRefused.mock.calls.length > 0);
		expect(await rcon.send('say hi')).toBe(false);
		rcon.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(server.connections()).toBe(1);
		expect(onLoginRefused).toHaveBeenCalledOnce();
		expect(server.commands()).toEqual([]);
	});

	it('refuses a bad command without waiting for a connection', async () => {
		const rcon = setup(1);
		await expect(rcon.send('say café')).rejects.toThrow(TypeError);
	});

	it('backs off from 1 s, doubling to 60 s, and starts over once connected', async () => {
		vi.useFakeTimers();
		const attempts: number[] = [];
		let succeed = false;
		const fakeConnection: RconConnection = { command: async () => '', close: () => {} };
		const connect = vi.fn<typeof connectRcon>(() => {
			attempts.push(Date.now());
			return succeed ? Promise.resolve(fakeConnection) : Promise.reject(new RconError('closed', 'refused'));
		});
		const rcon = createRcon({ host: 'h', port: 1, password: PASSWORD, log: () => {}, connect });
		rcon.start();
		await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16_000 + 32_000 + 60_000 + 60_000);
		const gaps = attempts.slice(1).map((time, index) => time - attempts[index]!);
		expect(gaps).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);

		succeed = true;
		await vi.advanceTimersByTimeAsync(60_000);
		const onClose = connect.mock.calls.at(-1)![0].onClose!;
		succeed = false;
		attempts.length = 0;
		onClose(new RconError('closed', 'dropped'));
		await vi.advanceTimersByTimeAsync(1000 + 2000);
		expect(attempts.length).toBe(2);
		rcon.stop();
	});

	it('discards a connection that opens after stop', async () => {
		let finish!: (connection: RconConnection) => void;
		const close = vi.fn();
		const connect = vi.fn(() => new Promise<RconConnection>((resolve) => (finish = resolve)));
		const rcon = createRcon({ host: 'h', port: 1, password: PASSWORD, log: () => {}, connect });
		rcon.start();
		rcon.stop();
		finish({ command: async () => '', close });
		await Promise.resolve();
		await Promise.resolve();
		expect(close).toHaveBeenCalledOnce();
		expect(await rcon.send('say hi')).toBe(false);
	});
});
