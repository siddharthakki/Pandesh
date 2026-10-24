import { RpcTransportHost } from './RpcServiceLifecycle';

export const LOOPBACK_RPC_HOST_SCHEMA_VERSION = 1 as const;

export interface LoopbackRpcHost extends RpcTransportHost {}

export function assertLoopbackRpcAddress(address: string): string {
  const parsed = new URL(address);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`RPC transport must use a loopback HTTP address: ${address}`);
  }
  return parsed.toString().replace(/\/$/, '');
}
