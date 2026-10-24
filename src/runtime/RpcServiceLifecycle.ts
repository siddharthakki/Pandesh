import { LocalRpcDispatcher, LocalRpcResponse } from './LocalRpcServer';

export interface RpcTransportRequest {
  payload: string;
  accessKey: string;
  clientId?: string;
}

export type RpcTransportHandler = (request: RpcTransportRequest) => Promise<LocalRpcResponse | null>;

export interface RpcTransportHost {
  start(handler: RpcTransportHandler): Promise<{ address: string }>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export class RpcServiceLifecycle {
  private host: RpcTransportHost | null = null;
  private currentAddress: string | null = null;

  constructor(readonly dispatcher: LocalRpcDispatcher) {}

  async start(host: RpcTransportHost): Promise<string> {
    if (this.host) {
      return this.currentAddress ?? '';
    }
    const result = await host.start(request => {
      return this.dispatcher.dispatch(request.payload, request.accessKey, request.clientId);
    });
    this.host = host;
    this.currentAddress = result.address;
    return result.address;
  }

  async stop(): Promise<void> {
    this.dispatcher.cancelAll();
    const host = this.host;
    this.host = null;
    this.currentAddress = null;
    await host?.stop();
  }

  isRunning(): boolean {
    return this.host?.isRunning() === true;
  }

  address(): string | null {
    return this.currentAddress;
  }
}
