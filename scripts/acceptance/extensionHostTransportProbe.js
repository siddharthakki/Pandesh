'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { Agent, Client, request } = require('undici');

const HEADER_DELAY_MS = 1500;
const LONG_TIMEOUT_MS = 3000;
const SHORT_TIMEOUT_MS = 250;
const ABORT_BUDGET_MS = 5000;

async function run() {
  const startedAt = Date.now();
  const evidenceDir = process.env.OLLAMA_AGENT_TRANSPORT_PROBE_EVIDENCE_DIR;
  const evidence = {
    scenario: 'extension_host_transport_probe',
    markers: [],
    runtime: runtimeMetadata(),
  };
  const record = (name, detail) => {
    const marker = { name, detail, elapsedMs: Date.now() - startedAt, at: new Date().toISOString() };
    evidence.markers.push(marker);
    console.log(`[extension-host-transport-probe] ${name}: ${detail ?? ''}`);
  };

  const server = new DelayedHeaderServer(HEADER_DELAY_MS);
  try {
    record('start', JSON.stringify(evidence.runtime));
    const baseUrl = await server.start();
    record('server-listening', baseUrl);

    const fetchResult = await probeFetch(baseUrl, record);
    evidence.fetch = fetchResult;

    let directResult;
    if (!fetchResult.dispatcherHonored) {
      record('direct-undici-required', 'fetch did not prove per-request dispatcher headersTimeout behavior');
      directResult = await probeDirectUndici(baseUrl, record);
      evidence.directUndici = directResult;
      assert.strictEqual(directResult.dispatcherHonored, true, `expected a direct Undici API to honor headersTimeout, got ${JSON.stringify(directResult)}`);
    }

    evidence.status = 'passed';
    record('complete', JSON.stringify({
      fetchDispatcherAccepted: fetchResult.dispatcherAccepted,
      fetchDispatcherHonored: fetchResult.dispatcherHonored,
      directApi: directResult?.api,
      nestedCauseCode: fetchResult.timeoutDiagnostic?.nestedCauseCode ?? directResult?.timeoutDiagnostic?.nestedCauseCode,
    }));
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    record('failed', evidence.error);
    throw error;
  } finally {
    await server.stop();
    record('cleanup-complete', JSON.stringify(server.cleanupSummary()));
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, 'extension-host-transport-probe.json'), JSON.stringify(evidence, null, 2));
    }
  }
}

async function probeFetch(baseUrl, record) {
  record('fetch-success-start', `delay=${HEADER_DELAY_MS} headersTimeout=${LONG_TIMEOUT_MS}`);
  const success = await runWithAgent(
    new Agent({ headersTimeout: LONG_TIMEOUT_MS, bodyTimeout: LONG_TIMEOUT_MS }),
    async (dispatcher, signal) => fetchJson(`${baseUrl}/delayed`, { dispatcher, signal }),
  );
  assert.deepStrictEqual(success.body, { ok: true });
  assert.ok(success.elapsedMs >= HEADER_DELAY_MS, `expected delayed headers to take at least ${HEADER_DELAY_MS}ms, got ${success.elapsedMs}ms`);
  record('fetch-success-complete', `elapsedMs=${success.elapsedMs}`);

  record('fetch-timeout-start', `delay=${HEADER_DELAY_MS} headersTimeout=${SHORT_TIMEOUT_MS}`);
  const timeout = await runWithAgent(
    new Agent({ headersTimeout: SHORT_TIMEOUT_MS, bodyTimeout: LONG_TIMEOUT_MS }),
    async (dispatcher, signal) => fetchJson(`${baseUrl}/delayed`, { dispatcher, signal }),
    { expectError: true },
  );
  record('fetch-timeout-complete', JSON.stringify(timeout.diagnostic));

  const dispatcherHonored = timeout.diagnostic?.nestedCauseCode === 'UND_ERR_HEADERS_TIMEOUT';
  return {
    dispatcherAccepted: success.ok,
    dispatcherHonored,
    successElapsedMs: success.elapsedMs,
    timeoutDiagnostic: timeout.diagnostic,
  };
}

async function probeDirectUndici(baseUrl, record) {
  record('undici-request-success-start', `delay=${HEADER_DELAY_MS} headersTimeout=${LONG_TIMEOUT_MS}`);
  const requestSuccess = await runWithAbortBudget(async signal => {
    const response = await request(`${baseUrl}/delayed`, {
      method: 'GET',
      headersTimeout: LONG_TIMEOUT_MS,
      bodyTimeout: LONG_TIMEOUT_MS,
      signal,
    });
    try {
      return await response.body.json();
    } finally {
      response.body.destroy();
    }
  });
  assert.deepStrictEqual(requestSuccess.body, { ok: true });
  record('undici-request-success-complete', `elapsedMs=${requestSuccess.elapsedMs}`);

  record('undici-request-timeout-start', `delay=${HEADER_DELAY_MS} headersTimeout=${SHORT_TIMEOUT_MS}`);
  const requestTimeout = await runWithAbortBudget(async signal => {
    await request(`${baseUrl}/delayed`, {
      method: 'GET',
      headersTimeout: SHORT_TIMEOUT_MS,
      bodyTimeout: LONG_TIMEOUT_MS,
      signal,
    });
  }, { expectError: true });
  record('undici-request-timeout-complete', JSON.stringify(requestTimeout.diagnostic));
  if (requestTimeout.diagnostic?.code === 'UND_ERR_HEADERS_TIMEOUT') {
    return {
      api: 'undici.request',
      dispatcherHonored: true,
      successElapsedMs: requestSuccess.elapsedMs,
      timeoutDiagnostic: requestTimeout.diagnostic,
    };
  }

  record('undici-client-success-start', `delay=${HEADER_DELAY_MS} headersTimeout=${LONG_TIMEOUT_MS}`);
  const client = new Client(baseUrl, { headersTimeout: LONG_TIMEOUT_MS, bodyTimeout: LONG_TIMEOUT_MS });
  try {
    const clientSuccess = await runWithAbortBudget(async signal => {
      const response = await client.request({ path: '/delayed', method: 'GET', signal });
      try {
        return await response.body.json();
      } finally {
        response.body.destroy();
      }
    });
    assert.deepStrictEqual(clientSuccess.body, { ok: true });
    record('undici-client-success-complete', `elapsedMs=${clientSuccess.elapsedMs}`);

    record('undici-client-timeout-start', `delay=${HEADER_DELAY_MS} headersTimeout=${SHORT_TIMEOUT_MS}`);
    const shortClient = new Client(baseUrl, { headersTimeout: SHORT_TIMEOUT_MS, bodyTimeout: LONG_TIMEOUT_MS });
    try {
      const clientTimeout = await runWithAbortBudget(
        async signal => shortClient.request({ path: '/delayed', method: 'GET', signal }),
        { expectError: true },
      );
      record('undici-client-timeout-complete', JSON.stringify(clientTimeout.diagnostic));
      return {
        api: 'undici.Client',
        dispatcherHonored: clientTimeout.diagnostic?.code === 'UND_ERR_HEADERS_TIMEOUT',
        successElapsedMs: clientSuccess.elapsedMs,
        timeoutDiagnostic: clientTimeout.diagnostic,
      };
    } finally {
      await shortClient.close();
    }
  } finally {
    await client.close();
  }
}

async function runWithAgent(agent, operation, options = {}) {
  try {
    return await runWithAbortBudget(signal => operation(agent, signal), options);
  } finally {
    await agent.close();
  }
}

async function fetchJson(url, { dispatcher, signal }) {
  const response = await fetch(url, { dispatcher, signal });
  assert.strictEqual(response.status, 200);
  return await response.json();
}

async function runWithAbortBudget(operation, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`probe abort budget exceeded after ${ABORT_BUDGET_MS}ms`));
  }, ABORT_BUDGET_MS);
  const started = Date.now();
  try {
    const body = await operation(controller.signal);
    if (options.expectError) {
      throw new Error('expected operation to fail, but it resolved');
    }
    return { ok: true, body, elapsedMs: Date.now() - started };
  } catch (error) {
    if (!options.expectError) {
      throw error;
    }
    return { ok: false, diagnostic: inspectError(error), elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function runtimeMetadata() {
  return {
    processVersion: process.version,
    node: process.versions.node,
    undici: process.versions.undici,
    hasGlobalFetch: typeof fetch === 'function',
  };
}

function inspectError(error) {
  const top = objectLike(error);
  const cause = objectLike(top?.cause);
  return {
    name: stringValue(top?.name),
    code: stringValue(top?.code),
    constructorName: constructorName(top),
    nestedCauseName: stringValue(cause?.name),
    nestedCauseCode: stringValue(cause?.code),
    nestedCauseConstructorName: constructorName(cause),
    message: typeof top?.message === 'string' ? top.message.slice(0, 160) : undefined,
  };
}

function objectLike(value) {
  return value && (typeof value === 'object' || typeof value === 'function') ? value : undefined;
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function constructorName(value) {
  return typeof value?.constructor === 'function' ? stringValue(value.constructor.name) : undefined;
}

class DelayedHeaderServer {
  constructor(delayMs) {
    this.delayMs = delayMs;
    this.timers = new Set();
    this.sockets = new Set();
    this.destroyedSockets = 0;
    this.server = http.createServer((_req, res) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      }, this.delayMs);
      this.timers.add(timer);
      res.once('close', () => {
        clearTimeout(timer);
        this.timers.delete(timer);
      });
    });
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('transport probe server did not receive a TCP address'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  async stop() {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await new Promise((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve());
      this.server.closeIdleConnections?.();
      this.server.closeAllConnections?.();
      for (const socket of this.sockets) {
        if (socket instanceof net.Socket && !socket.destroyed) {
          this.destroyedSockets += 1;
          socket.destroy();
        }
      }
    });
    await this.waitForSocketsToClose();
  }

  cleanupSummary() {
    return {
      pendingTimers: this.timers.size,
      openSockets: this.sockets.size,
      destroyedSockets: this.destroyedSockets,
    };
  }

  async waitForSocketsToClose() {
    const deadline = Date.now() + 1000;
    while (this.sockets.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

module.exports = { run };
