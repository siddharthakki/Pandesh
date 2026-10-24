import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { MobileServer } from '../src/host/mobileServer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-mobile-test-'));
  dirs.push(dir);
  return dir;
}

function createMockSession() {
  return {
    snapshot: vi.fn(() => ({
      coreConnected: true,
      selectedModel: 'qwen3.8:27b-mtp-q4_K_M',
      workspaceRoot: 'C:\\Projects\\ollama-agent',
      pendingApproval: null,
      telemetry: {
        cpu: { percent: 12 },
        ram: { usedGb: 18, totalGb: 64 },
        gpu: { model: 'NVIDIA RTX 3090', vramUsedMb: 6144, vramTotalMb: 24576 },
      },
    })),
    getActiveConversationMessages: vi.fn(async () => [
      { id: 'm1', role: 'assistant', content: 'Hello!' },
    ]),
    submitTask: vi.fn(async (text: string) => ({
      outcome: 'answered',
      summary: 'Task executed',
      text: `Pandesh response to: ${text}`,
    })),
    resolvePending: vi.fn(async (_approvalId: string, resolution: string) => ({
      coreConnected: true,
      resolved: resolution,
    })),
    onEvent: vi.fn(() => () => {}),
    transcribeUtteranceWavBase64: vi.fn(async () => ({ text: 'Transcribed utterance' })),
    speakText: vi.fn(async () => ({ wavBase64: 'UklGRg==' })),
    getArtifactContent: vi.fn(async (id: string) => {
      if (id === 'art-image-1') {
        return { kind: 'image', mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), title: 'photo.png' };
      }
      if (id === 'art-doc-1') {
        return { kind: 'document', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4'), title: 'Invoice.pdf' };
      }
      if (id === 'art-file-1') {
        return { kind: 'file', mimeType: 'application/zip', bytes: Buffer.from('PK...'), title: 'Report (final)/draft".zip' };
      }
      if (id === 'art-utf8-1') {
        return { kind: 'file', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4'), title: "Résumé – 日本語 (it's 100%).pdf" };
      }
      if (id === 'art-svg-1') {
        return { kind: 'image', mimeType: 'image/svg+xml', bytes: Buffer.from('<svg onload="alert(1)"></svg>'), title: 'evil.svg' };
      }
      throw new Error('Internal: artifact lookup failed at /secret/db/path.sqlite');
    }),
  };
}

describe('KarkeDikha Mobile Server (Unified Session Protocol)', () => {
  it('serves valid companion HTML and enforces single cookie session across endpoints', async () => {
    const dataDir = createTempDir();
    const session = createMockSession();
    const logs: string[] = [];

    const server = new MobileServer({
      dataDir,
      session: session as any,
      port: 3039,
      host: '127.0.0.1',
      log: (msg) => logs.push(msg),
    });

    await server.start();
    try {
      const info = server.getPairingInfo();
      expect(info.code).toMatch(/^[A-Z0-9]{4,6}$/);
      expect(info.port).toBe(3039);

      // 1. Check HTML companion UI and verify embedded script has zero syntax errors
      const htmlRes = await fetch('http://127.0.0.1:3039/?pair=QFB8');
      expect(htmlRes.status).toBe(200);
      const htmlText = await htmlRes.text();
      expect(htmlText).toContain('KarkeDikha');
      expect(htmlText).toContain('Pandesh');
      expect(htmlText).toContain('Diagnostics');

      const scriptMatch = htmlText.match(/<script>([\s\S]*?)<\/script>/);
      expect(scriptMatch).not.toBeNull();
      // Compile script in isolated VM to verify syntax is 100% valid
      expect(() => new vm.Script(scriptMatch![1])).not.toThrow();

      // 2. Check public status API
      const statusRes = await fetch('http://127.0.0.1:3039/api/status');
      expect(statusRes.status).toBe(200);
      const statusData = await statusRes.json();
      expect(statusData).toMatchObject({
        brand: 'KarkeDikha',
        assistant: 'Pandesh',
        ready: true,
        model: 'qwen3.8:27b-mtp-q4_K_M',
      });

      // 3. Unauthenticated session check returns 401
      const unauthSessionRes = await fetch('http://127.0.0.1:3039/api/session');
      expect(unauthSessionRes.status).toBe(401);

      // 4. Reject invalid pairing PIN
      const badPairRes = await fetch('http://127.0.0.1:3039/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'WRONG_PIN' }),
      });
      expect(badPairRes.status).toBe(401);

      // 5. Accept correct pairing PIN and issue HttpOnly session cookie
      const pairRes = await fetch('http://127.0.0.1:3039/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: info.code }),
      });
      expect(pairRes.status).toBe(200);
      const pairData = await pairRes.json();
      expect(pairData.ok).toBe(true);

      const setCookie = pairRes.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain('kkd_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      // Must not contain Secure for plain LAN HTTP
      expect(setCookie).not.toContain('Secure');

      const cookieMatch = setCookie!.match(/(?:^|;\s*)kkd_session=([^;]+)/);
      expect(cookieMatch).toBeTruthy();
      const cookieHeader = `kkd_session=${cookieMatch![1]}`;

      // 6. Check authenticated session endpoint with cookie
      const authSessionRes = await fetch('http://127.0.0.1:3039/api/session', {
        headers: { Cookie: cookieHeader },
      });
      expect(authSessionRes.status).toBe(200);
      const authSessionData = await authSessionRes.json();
      expect(authSessionData.ok).toBe(true);

      // 7. Submit message with session cookie
      const submitRes = await fetch('http://127.0.0.1:3039/api/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({ message: 'Hi Pandesh' }),
      });
      expect(submitRes.status).toBe(200);
      const submitData = await submitRes.json();
      expect(session.submitTask).toHaveBeenCalledWith('Hi Pandesh', undefined, undefined, 'mobile');
      expect(submitData.text).toContain('Pandesh response to: Hi Pandesh');

      // 8. Query messages with session cookie
      const messagesRes = await fetch('http://127.0.0.1:3039/api/messages', {
        headers: { Cookie: cookieHeader },
      });
      expect(messagesRes.status).toBe(200);
      const messagesData = await messagesRes.json();
      expect(messagesData.messages).toHaveLength(1);

      // 9. Query snapshot with session cookie
      const snapRes = await fetch('http://127.0.0.1:3039/api/snapshot', {
        headers: { Cookie: cookieHeader },
      });
      expect(snapRes.status).toBe(200);
      const snapData = await snapRes.json();
      expect(snapData.workspaceRoot).toBe('C:\\Projects\\ollama-agent');

      // 10a. Unauthenticated artifact content request returns 401
      const unauthArtifactRes = await fetch('http://127.0.0.1:3039/api/artifacts/art-image-1/content');
      expect(unauthArtifactRes.status).toBe(401);

      // 10b. Authenticated image artifact request returns 200 with correct headers
      const imageRes = await fetch('http://127.0.0.1:3039/api/artifacts/art-image-1/content', {
        headers: { Cookie: cookieHeader },
      });
      expect(imageRes.status).toBe(200);
      expect(imageRes.headers.get('content-type')).toBe('image/png');
      expect(imageRes.headers.get('cache-control')).toBe('no-store');
      expect(imageRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(imageRes.headers.get('content-disposition')).toBe('inline');
      expect(imageRes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      const imageBytes = Buffer.from(await imageRes.arrayBuffer());
      expect(imageBytes).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      // 10b2. An SVG image artifact must never be served inline — it can execute script with the session cookie
      const svgRes = await fetch('http://127.0.0.1:3039/api/artifacts/art-svg-1/content', {
        headers: { Cookie: cookieHeader },
      });
      expect(svgRes.status).toBe(200);
      expect(svgRes.headers.get('content-type')).toBe('image/svg+xml');
      const svgDisposition = svgRes.headers.get('content-disposition') || '';
      expect(svgDisposition).toMatch(/^attachment;/);
      expect(svgDisposition).not.toBe('inline');
      expect(svgRes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");

      // 10c. Authenticated PDF document artifact is served inline as application/pdf
      const pdfRes = await fetch('http://127.0.0.1:3039/api/artifacts/art-doc-1/content', {
        headers: { Cookie: cookieHeader },
      });
      expect(pdfRes.status).toBe(200);
      expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
      expect(pdfRes.headers.get('content-disposition')).toBe('inline');
      expect(pdfRes.headers.get('cache-control')).toBe('no-store');
      expect(pdfRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(pdfRes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
      expect(pdfBytes.toString()).toBe('%PDF-1.4');

      // 10d. Unauthenticated PDF request still returns 401
      const unauthPdfRes = await fetch('http://127.0.0.1:3039/api/artifacts/art-doc-1/content');
      expect(unauthPdfRes.status).toBe(401);

      // 10e. Other document/file artifacts are served as attachment downloads with a sanitized filename
      const fileRes = await fetch('http://127.0.0.1:3039/api/artifacts/art-file-1/content', {
        headers: { Cookie: cookieHeader },
      });
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers.get('content-type')).toBe('application/zip');
      const fileDisposition = fileRes.headers.get('content-disposition') || '';
      const fileDispositionMatch = fileDisposition.match(/^attachment; filename="([^]*)"$/);
      expect(fileDispositionMatch).not.toBeNull();
      const sanitizedFilename = fileDispositionMatch![1];
      expect(sanitizedFilename).toBe('Report (final)_draft_.zip');
      expect(sanitizedFilename).not.toContain('/');
      expect(sanitizedFilename).not.toContain('"');
      expect(fileRes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");

      // 10e2. Authenticated HEAD: same headers as GET, no body, and the session gate still applies
      const headRes = await fetch('http://127.0.0.1:3039/api/artifacts/art-doc-1/content', { method: 'HEAD', headers: { Cookie: cookieHeader } });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('content-length')).toBe('8');
      expect(headRes.headers.get('accept-ranges')).toBe('bytes');
      expect(headRes.headers.get('content-disposition')).toBe('inline');
      expect((await headRes.arrayBuffer()).byteLength).toBe(0);
      expect((await fetch('http://127.0.0.1:3039/api/artifacts/art-doc-1/content', { method: 'HEAD' })).status).toBe(401);

      // 10e3. Byte ranges: bounded, open-ended, suffix, clamped, unsatisfiable and ignored-malformed
      const rangeOf = (range: string, extra: Record<string, string> = {}, method = 'GET') =>
        fetch('http://127.0.0.1:3039/api/artifacts/art-doc-1/content', { method, headers: { Cookie: cookieHeader, Range: range, ...extra } });
      const r1 = await rangeOf('bytes=1-3');
      expect(r1.status).toBe(206);
      expect(r1.headers.get('content-range')).toBe('bytes 1-3/8');
      expect(r1.headers.get('content-length')).toBe('3');
      expect(Buffer.from(await r1.arrayBuffer()).toString()).toBe('PDF');
      const r2 = await rangeOf('bytes=4-');
      expect(r2.status).toBe(206);
      expect(Buffer.from(await r2.arrayBuffer()).toString()).toBe('-1.4');
      const r3 = await rangeOf('bytes=-3');
      expect(r3.headers.get('content-range')).toBe('bytes 5-7/8');
      expect(Buffer.from(await r3.arrayBuffer()).toString()).toBe('1.4');
      const r4 = await rangeOf('bytes=6-999');
      expect(r4.headers.get('content-range')).toBe('bytes 6-7/8');
      await r4.arrayBuffer();
      const r5 = await rangeOf('bytes=8-');
      expect(r5.status).toBe(416);
      expect(r5.headers.get('content-range')).toBe('bytes */8');
      await r5.arrayBuffer();
      const r6 = await rangeOf('bytes=0-1,3-4');
      expect(r6.status).toBe(200);
      expect(Buffer.from(await r6.arrayBuffer()).toString()).toBe('%PDF-1.4');
      const r7 = await rangeOf('bytes=1-3', { 'If-Range': '"x"' });
      expect(r7.status).toBe(200);
      await r7.arrayBuffer();
      const r8 = await rangeOf('bytes=1-3', {}, 'HEAD');
      expect(r8.status).toBe(206);
      expect(r8.headers.get('content-length')).toBe('3');
      expect((await r8.arrayBuffer()).byteLength).toBe(0);

      // 10e4. ?download=1 forces an attachment even for an inline-able PDF
      const dlRes = await fetch('http://127.0.0.1:3039/api/artifacts/art-doc-1/content?download=1', { headers: { Cookie: cookieHeader } });
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get('content-disposition')).toBe('attachment; filename="Invoice.pdf"');
      await dlRes.arrayBuffer();

      // 10e5. Non-ASCII names: quoted ASCII fallback plus RFC 8187 filename*, no raw non-ASCII or %/'()* in the value
      const u8 = await fetch('http://127.0.0.1:3039/api/artifacts/art-utf8-1/content?download=1', { headers: { Cookie: cookieHeader } });
      expect(u8.status).toBe(200);
      expect(u8.headers.get('content-disposition')).toBe(
        "attachment; filename=\"R_sum_ _ ___ (it's 100_).pdf\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E2%80%93%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%28it%27s%20100%25%29.pdf",
      );
      await u8.arrayBuffer();

      // 10f. Unknown artifact id returns 404 (authenticated, verified-artifact lookup failed) without leaking internal error text
      const missingRes = await fetch('http://127.0.0.1:3039/api/artifacts/does-not-exist/content', {
        headers: { Cookie: cookieHeader },
      });
      expect(missingRes.status).toBe(404);
      expect(missingRes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      const missingData = await missingRes.json();
      expect(missingData.error).toBe('Not found');
      expect(JSON.stringify(missingData)).not.toContain('secret');
      expect(JSON.stringify(missingData)).not.toContain('.sqlite');

      // 11. Verify safe server diagnostics logs were emitted
      expect(logs).toContain('[MOBILE] pair requested');
      expect(logs).toContain('[MOBILE] pair success');
      expect(logs).toContain('[MOBILE] session recognized');
      expect(logs).toContain('[MOBILE] submit accepted');
      expect(logs).toContain('[MOBILE] result delivered');
      expect(logs).toContain('[MOBILE] messages 200');
    } finally {
      server.stop();
    }
  });

  it('renders image artifact markdown as a cookie-authenticated same-origin <img> tag', async () => {
    const dataDir = createTempDir();
    const session = createMockSession();

    const server = new MobileServer({
      dataDir,
      session: session as any,
      port: 3040,
      host: '127.0.0.1',
    });

    await server.start();
    try {
      const htmlRes = await fetch('http://127.0.0.1:3040/');
      const htmlText = await htmlRes.text();
      const scriptMatch = htmlText.match(/<script>([\s\S]*?)<\/script>/);
      expect(scriptMatch).not.toBeNull();

      const document: any = {
        createElement: (tag: string) => ({ tagName: tag, style: {}, appendChild() {} }),
        createTextNode: (text: string) => ({ text }),
      };

      // Extract and evaluate just the renderMobileMarkdown function body in isolation.
      const fnSource = scriptMatch![1].match(/function renderMobileMarkdown\(text\) \{[\s\S]*?\n      \}/);
      expect(fnSource).not.toBeNull();
      // eslint-disable-next-line no-new-func
      const renderMobileMarkdown = new Function('document', `${fnSource![0]}; return renderMobileMarkdown;`)(document);

      const createdImages: any[] = [];
      const wrap = {
        appendChild: (child: any) => {
          if (child.tagName === 'img') createdImages.push(child);
        },
      };
      document.createElement = (tag: string) => {
        if (tag === 'div') return wrap;
        return { tagName: tag, style: {}, appendChild() {} };
      };

      renderMobileMarkdown('![a generated image](artifact:art-image-1)');
      expect(createdImages).toHaveLength(1);
      expect(createdImages[0].src).toBe('/api/artifacts/art-image-1/content');
      expect(createdImages[0].alt).toBe('a generated image');
    } finally {
      server.stop();
    }
  });

  it('renders document artifact markdown as a compact card linking to the artifact content route', async () => {
    const dataDir = createTempDir();
    const session = createMockSession();

    const server = new MobileServer({
      dataDir,
      session: session as any,
      port: 3041,
      host: '127.0.0.1',
    });

    await server.start();
    try {
      const htmlRes = await fetch('http://127.0.0.1:3041/');
      const htmlText = await htmlRes.text();
      const scriptMatch = htmlText.match(/<script>([\s\S]*?)<\/script>/);
      expect(scriptMatch).not.toBeNull();

      const document: any = {
        createElement: (tag: string) => ({ tagName: tag, style: {}, appendChild() {} }),
        createTextNode: (text: string) => ({ text }),
      };

      const fnSource = scriptMatch![1].match(/function renderMobileMarkdown\(text\) \{[\s\S]*?\n      \}/);
      expect(fnSource).not.toBeNull();
      // eslint-disable-next-line no-new-func
      const renderMobileMarkdown = new Function('document', `${fnSource![0]}; return renderMobileMarkdown;`)(document);

      const createdCards: any[] = [];
      const wrap = {
        style: {},
        appendChild: (child: any) => {
          if (child.tagName === 'a') createdCards.push(child);
        },
      };
      document.createElement = (tag: string) => {
        if (tag === 'div') return wrap;
        return { tagName: tag, style: {}, appendChild() {} };
      };

      renderMobileMarkdown('[Invoice.pdf](artifact:art-doc-1)');
      // Separate Open and Download controls
      expect(createdCards).toHaveLength(2);
      expect(createdCards[0].textContent).toBe('Open');
      expect(createdCards[0].href).toBe('/api/artifacts/art-doc-1/content');
      expect(createdCards[0].target).toBe('_blank');
      expect(createdCards[1].textContent).toBe('Download');
      expect(createdCards[1].href).toBe('/api/artifacts/art-doc-1/content?download=1');
      expect(createdCards[1].download).toBe('Invoice.pdf');
    } finally {
      server.stop();
    }
  });
  it('phone worker approvals need a paired session, are attributed to the phone, and never carry the host token', async () => {
    const decide = vi.fn(async () => ({ ok: true }));
    const session = { ...createMockSession(), decideDevStoryPermission: decide };
    const server = new MobileServer({ dataDir: createTempDir(), session: session as any, port: 3043, host: '127.0.0.1' });
    await server.start();
    try {
      const url = 'http://127.0.0.1:3043/api/dev-stories/story-1/permissions/pend-1';
      const post = (headers: Record<string, string>, body: unknown) =>
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

      // No pairing: refused before the host is asked to decide anything.
      expect((await post({}, { allow: true })).status).toBe(401);
      // A client-supplied host token or client id header grants nothing without a paired session.
      expect((await post({ 'X-Host-Token': 'anything', 'X-Client-Id': 'desktop_x' }, { allow: true })).status).toBe(401);
      expect(decide).not.toHaveBeenCalled();

      const pairRes = await fetch('http://127.0.0.1:3043/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: server.getPairingInfo().code }),
      });
      const cookie = (pairRes.headers.get('set-cookie') || '').split(';')[0];
      expect(cookie).toMatch(/^kkd_session=/);

      expect((await post({ Cookie: cookie }, { allow: 'yes' })).status).toBe(400);
      const ok = await post({ Cookie: cookie }, { allow: false });
      expect(ok.status).toBe(200);
      // The host-side session, not the phone, attaches the host token; the phone only names itself as the channel.
      expect(decide).toHaveBeenCalledExactlyOnceWith('story-1', 'pend-1', false, 'phone');

      // Nothing the phone can fetch contains the desktop host secret.
      const page = await (await fetch('http://127.0.0.1:3043/')).text();
      expect(page.toLowerCase()).not.toContain('host-token');
      expect(page.toLowerCase()).not.toContain('host.token');
      expect(JSON.stringify(await ok.json())).not.toMatch(/token/i);
    } finally {
      server.stop();
    }
  });
});
