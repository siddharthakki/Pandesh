import { describe, expect, it } from 'vitest';
import { LocalRpcDispatcher } from '../../runtime/LocalRpcServer';
import { RpcServiceLifecycle, RpcTransportHandler, RpcTransportHost } from '../../runtime/RpcServiceLifecycle';

class FakeHost implements RpcTransportHost {
  private handler?: RpcTransportHandler;
  private running = false;

  async start(handler: RpcTransportHandler): Promise<{ address: string }> {
    this.handler = handler;
    this.running = true;
    return { address: 'local-agent' };
  }

  async stop(): Promise<void> {
    this.handler = undefined;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async send(payload: string, accessKey: string) {
    if (!this.handler) {
      throw new Error('Host is stopped.');
    }
    return this.handler({ payload, accessKey, clientId: 'test' });
  }
}

describe('Phase 18 RPC dispatcher', () => {
  it('dispatches a registered method', async () => {
    const accessKey = 'x'.repeat(24);
    const dispatcher = new LocalRpcDispatcher(accessKey);
    dispatcher.register('runtime.echo', async params => params);

    const response = await dispatcher.dispatch(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'runtime.echo', params: { value: 2 },
    }), accessKey);
    expect(response).toEqual({ jsonrpc: '2.0', id: 2, result: { value: 2 } });
  });

  it('starts and stops through a transport host abstraction', async () => {
    const accessKey = 'y'.repeat(24);
    const dispatcher = new LocalRpcDispatcher(accessKey);
    dispatcher.register('runtime.ping', async () => ({ ok: true }));
    const service = new RpcServiceLifecycle(dispatcher);
    const host = new FakeHost();

    expect(await service.start(host)).toBe('local-agent');
    const response = await host.send(JSON.stringify({
      jsonrpc: '2.0', id: 'ping', method: 'runtime.ping',
    }), accessKey);
    expect(response?.result).toEqual({ ok: true });

    await service.stop();
    expect(service.isRunning()).toBe(false);
  });
});
