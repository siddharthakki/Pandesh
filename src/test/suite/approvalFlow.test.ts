import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalFlow, ApprovalRequest } from '../../policy/ApprovalFlow';

describe('ApprovalFlow — approval lifecycle', () => {
  let flow: ApprovalFlow;

  beforeEach(() => {
    flow = new ApprovalFlow();
  });

  it('resolves exactly once when approved', async () => {
    const promise = flow.requestApproval('read_file', {}, 'test', 'safe');
    flow.respond(flow['pending'].keys().next().value as string, 'approved');
    await expect(promise).resolves.toBe('approved');
  });

  it('resolves exactly once when rejected', async () => {
    const promise = flow.requestApproval('write_file', {}, 'test', 'medium');
    const id = [...flow['pending'].keys()][0];
    flow.respond(id, 'rejected');
    await expect(promise).resolves.toBe('rejected');
  });

  it('respond returns false for an unknown id', () => {
    const result = flow.respond('no-such-id', 'approved');
    expect(result).toBe(false);
  });

  it('second respond on same id returns false (idempotent)', async () => {
    const promise = flow.requestApproval('write_file', {}, 'test', 'medium');
    const id = [...flow['pending'].keys()][0];
    const first = flow.respond(id, 'approved');
    const second = flow.respond(id, 'rejected');
    expect(first).toBe(true);
    expect(second).toBe(false);
    await promise;
  });

  it('keeps respond synchronous while awaiting durable resolution', async () => {
    let release!: () => void;
    const durableUpdate = new Promise<void>(resolve => { release = resolve; });
    flow.onApprovalResolved = async () => durableUpdate;

    const promise = flow.requestApproval('write_file', {}, 'test', 'medium');
    const id = [...flow['pending'].keys()][0];
    let settled = false;
    void promise.then(() => { settled = true; });

    expect(flow.respond(id, 'approved')).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(promise).resolves.toBe('approved');
  });

  it('cancelAll rejects all pending with an error', async () => {
    const p1 = flow.requestApproval('tool_a', {}, 'test', 'low');
    const p2 = flow.requestApproval('tool_b', {}, 'test', 'low');
    flow.cancelAll();
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
  });

  it('hasPending is true while approval is outstanding', () => {
    flow.requestApproval('write_file', {}, 'test', 'medium');
    expect(flow.hasPending()).toBe(true);
  });

  it('hasPending is false after resolution', async () => {
    const p = flow.requestApproval('write_file', {}, 'test', 'medium');
    const id = [...flow['pending'].keys()][0];
    flow.respond(id, 'approved');
    await p;
    expect(flow.hasPending()).toBe(false);
  });

  it('stop via AbortSignal cancels pending approval', async () => {
    const controller = new AbortController();
    const p = flow.requestApproval('write_file', {}, 'test', 'medium', controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow('cancelled');
  });

  it('onRequest callback receives the request after durable preparation', async () => {
    let received!: ApprovalRequest;
    let requestShown!: () => void;
    const shown = new Promise<void>(resolve => { requestShown = resolve; });
    flow.setOnRequest(req => {
      received = req;
      requestShown();
    });

    const p = flow.requestApproval('run_command', { command: 'ls' }, 'test', 'high');
    await shown;

    expect(received.toolName).toBe('run_command');
    expect(flow.respond(received.id, 'approved')).toBe(true);
    await p;
  });
});
