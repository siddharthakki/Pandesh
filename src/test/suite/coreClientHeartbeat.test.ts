import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CoreClient } from '../../core-client/CoreClient';
import type { CoreConnectionState } from '../../core-client/ConnectionState';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startHeartbeatFixture(mode: 'pong' | 'ping' | 'silent'): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const token = 'heartbeat-test-token';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/v1/clients/register' && req.method === 'POST') {
      res.writeHead(200);
      res.end('{}');
      return;
    }
    if (url.pathname === '/v1/board/snapshot') {
      res.writeHead(200);
      res.end(JSON.stringify({ latestSequence: 0, projects: [], stories: [], serverTimeIso: new Date().toISOString() }));
      return;
    }
    if (url.pathname === '/v1/events' || url.pathname === '/v1/runtime-events') {
      res.writeHead(200);
      res.end(JSON.stringify({ events: [] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
  });

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let beat: NodeJS.Timeout | undefined;

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/v1/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.send(JSON.stringify({ type: 'connected', instanceId: 'heartbeat-test', latestSequence: 0 }));
      if (mode !== 'silent') {
        beat = setInterval(() => {
          for (const client of sockets) {
            if (client.readyState === client.OPEN) {
              if (mode === 'pong') client.pong();
              else client.ping();
            }
          }
        }, 20);
      }
      ws.on('close', () => sockets.delete(ws));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      if (beat) clearInterval(beat);
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('CoreClient WebSocket heartbeat liveness', () => {
  const clients: CoreClient[] = [];
  const fixtures: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  it('keeps the connection stable when only heartbeat pongs arrive', async () => {
    const fixture = await startHeartbeatFixture('pong');
    fixtures.push(fixture);
    const states: CoreConnectionState[] = [];
    const client = new CoreClient({
      baseUrl: fixture.baseUrl,
      token: 'heartbeat-test-token',
      clientId: 'heartbeat-pong',
      clientVersion: '0.1.0',
      heartbeatStaleMs: 80,
      onStatusChange: (status) => states.push(status.state),
    });
    clients.push(client);
    await client.start();
    await sleep(250);
    expect(client.getStatus().state).toBe('connected');
    expect(states).not.toContain('reconnecting');
  });

  it('keeps the connection stable when only Core ping frames arrive', async () => {
    const fixture = await startHeartbeatFixture('ping');
    fixtures.push(fixture);
    const states: CoreConnectionState[] = [];
    const client = new CoreClient({
      baseUrl: fixture.baseUrl,
      token: 'heartbeat-test-token',
      clientId: 'heartbeat-ping',
      clientVersion: '0.1.0',
      heartbeatStaleMs: 80,
      onStatusChange: (status) => states.push(status.state),
    });
    clients.push(client);
    await client.start();
    await sleep(250);
    expect(client.getStatus().state).toBe('connected');
    expect(states).not.toContain('reconnecting');
  });

  it('still reconnects when neither messages nor heartbeat frames arrive', async () => {
    const fixture = await startHeartbeatFixture('silent');
    fixtures.push(fixture);
    const states: CoreConnectionState[] = [];
    const client = new CoreClient({
      baseUrl: fixture.baseUrl,
      token: 'heartbeat-test-token',
      clientId: 'heartbeat-silent',
      clientVersion: '0.1.0',
      heartbeatStaleMs: 80,
      onStatusChange: (status) => states.push(status.state),
    });
    clients.push(client);
    await client.start();
    await sleep(250);
    expect(states).toContain('reconnecting');
  });
});
