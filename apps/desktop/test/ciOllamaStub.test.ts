/**
 * Build 161 audit: the CI Ollama stub, started on a machine where Ollama already listened on [::], was accepted on
 * 127.0.0.1 beside it and received every new IPv4 loopback connection meant for the real Ollama (started in the
 * foreground it also blocked a local test run for hours). It must refuse a port that is already served, and still
 * stand in when nothing serves it. Spare ports only, through OLLAMA_STUB_PORT; never 11434.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

const stubScript = path.resolve(__dirname, '../../../scripts/ci/ollama-tags-stub.mjs');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const undo of cleanup.splice(0)) undo(); });

/** A fresh connection every time (no keep-alive), so the answer shows which listener the OS chose. */
function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

async function listen(server: http.Server, port: number, host: string): Promise<number> {
  cleanup.push(() => server.close());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
  return (server.address() as AddressInfo).port;
}

function startStub(port: number) {
  const child = spawn(process.execPath, [stubScript], { env: { ...process.env, OLLAMA_STUB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => child.kill());
  let stdout = '';
  let stderr = '';
  const listening = new Promise<void>((resolve) => child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('ollama tags stub on')) resolve(); }));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { listening, exited, stderr: () => stderr };
}

describe('CI Ollama stub', () => {
  it('refuses to start when Ollama already listens on the port, and leaves it answering', async () => {
    const port = await listen(http.createServer((_req, res) => res.end('real ollama')), 0, '::'); // dual-stack, like this machine's Ollama
    const stub = startStub(port);
    expect(await stub.exited).toBe(1);
    expect(stub.stderr()).toMatch(/already served/);
    expect(await get(port, '/api/version')).toEqual({ status: 200, body: 'real ollama' });
  }, 20_000);

  it('stands in when nothing serves the port: lists the models and serves nothing else', async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve())); // a port nothing serves
    const stub = startStub(port);
    await stub.listening;
    const tags = await get(port, '/api/tags');
    expect(tags.status).toBe(200);
    expect(JSON.parse(tags.body).models.map((m: { name: string }) => m.name)).toEqual(['qwen3.8:27b-mtp-q4_K_M', 'gemma4:12b']);
    expect((await get(port, '/api/chat')).status).toBe(404);
  }, 20_000);
});
