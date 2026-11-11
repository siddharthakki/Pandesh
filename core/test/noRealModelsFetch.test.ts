/**
 * The no-real-models test setup must leave the built-in fetch exactly as it is. Its first version imported undici, which
 * made undici's Agent the default dispatcher of Node's fetch, and 14 attachment upload tests failed with "invalid
 * content-length header". This file imports nothing that loads undici, like those tests.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

describe('the no-real-models setup leaves the built-in fetch alone', () => {
  it('an upload that sets its own Content-Length still reaches a local server', async () => {
    const server = http.createServer((request, response) => {
      let received = 0;
      request.on('data', (chunk: Buffer) => { received += chunk.length; });
      request.on('end', () => response.end(`${received} bytes, content-length ${request.headers['content-length']}`));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = Buffer.from('hello world');
      const response = await fetch(`http://127.0.0.1:${port}/upload`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
        body,
      });
      expect(await response.text()).toBe('11 bytes, content-length 11');
    } finally {
      server.close();
    }
  });
});
