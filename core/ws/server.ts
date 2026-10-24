import * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken, extractBearerToken } from '../auth/token';
import type { EventBroadcaster, RuntimeTokenFrame } from './broadcaster';
import type { StoryEventRecord, RuntimeEventRecord } from '../shared/wireTypes';

const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024; // 4MB per-client outgoing buffer bound

export interface StartWsServerOptions {
  httpServer: http.Server;
  token: string;
  broadcaster: EventBroadcaster;
  instanceId: string;
  latestSequence: () => number;
}

interface ClientState {
  alive: boolean;
}

export function attachWsServer(options: StartWsServerOptions): { close(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const clientState = new WeakMap<WebSocket, ClientState>();

  options.httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/v1/ws') {
      socket.destroy();
      return;
    }
    const token = extractBearerToken(req.headers.authorization);
    if (!verifyToken(token, options.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    clientState.set(ws, { alive: true });
    ws.send(
      JSON.stringify({
        type: 'connected',
        instanceId: options.instanceId,
        latestSequence: options.latestSequence(),
      }),
    );

    ws.on('pong', () => {
      const state = clientState.get(ws);
      if (state) state.alive = true;
    });

    ws.on('error', () => {
      ws.terminate();
    });
  });

  const broadcastToOpenClients = (payload: string) => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        // Client can't keep up; drop it rather than let memory grow unbounded. It will reconnect
        // and replay missed events via GET /v1/events?after= or /v1/runtime-events?after=.
        client.terminate();
        continue;
      }
      client.send(payload);
    }
  };

  const onEvent = (event: StoryEventRecord) => {
    broadcastToOpenClients(JSON.stringify({ type: 'event', event }));
  };
  options.broadcaster.on('story_event', onEvent);

  const onRuntimeEvent = (event: RuntimeEventRecord) => {
    broadcastToOpenClients(JSON.stringify({ type: 'runtime_event', event }));
  };
  options.broadcaster.on('runtime_event', onRuntimeEvent);

  const onRuntimeToken = (frame: RuntimeTokenFrame) => {
    broadcastToOpenClients(JSON.stringify({ type: 'runtime_token', ...frame }));
  };
  options.broadcaster.on('runtime_token', onRuntimeToken);

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const state = clientState.get(client);
      if (!state?.alive) {
        client.terminate();
        continue;
      }
      state.alive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      options.broadcaster.off('story_event', onEvent);
      options.broadcaster.off('runtime_event', onRuntimeEvent);
      options.broadcaster.off('runtime_token', onRuntimeToken);
      for (const client of wss.clients) {
        client.close(4000, 'server_shutdown');
      }
      wss.close();
    },
  };
}
