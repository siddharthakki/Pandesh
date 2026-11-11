import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { mockSession, pair, startServer, tempDir } from './mobileTestKit';

const mobileFile = (name: string) => path.join(__dirname, '..', 'renderer', 'mobile', name);

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function server(options: Parameters<typeof startServer>[1] = {}) {
  const s = await startServer(dirs, options);
  stops.push(() => s.server.stop());
  return s;
}

describe('Pandesh Mobile Server (Unified Session Protocol)', () => {
  it('serves the Pandesh phone app and enforces a single cookie session across endpoints', async () => {
    const { server: mobile, session, logs, base, port } = await server();
    const info = mobile.getPairingInfo();
    expect(info.code).toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
    expect(info.port).toBe(port);

    // 1. The app page: Pandesh, no KarkeDikha, no inline script (the page's CSP allows only its own files).
    const htmlRes = await fetch(`${base}/?pair=ABCD-EFGH`);
    expect(htmlRes.status).toBe(200);
    const htmlText = await htmlRes.text();
    expect(htmlText).toContain('<title>Pandesh</title>');
    expect(htmlText).not.toContain('KarkeDikha');
    expect(htmlText).not.toMatch(/<script>(?!<\/script>)|<script(?![^>]*\bsrc=)[^>]*>/);
    expect(htmlText).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    for (const file of ['/lib.js', '/app.js', '/sw.js']) {
      const js = await (await fetch(`${base}${file}`)).text();
      expect(() => new vm.Script(js)).not.toThrow();
    }

    // 2. Public status: enough to know the PC answers, nothing about what is on it.
    const statusRes = await fetch(`${base}/api/status`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData).toEqual({ brand: 'Pandesh', assistant: 'Pandesh', ready: true, coreState: 'connected', secure: false });

    // 3. Unauthenticated session check returns 401
    expect((await fetch(`${base}/api/session`)).status).toBe(401);

    // 4. Reject a wrong pairing code
    expect((await pair(base, 'WRONG_PIN')).status).toBe(401);

    // 5. Accept the right code and issue an HttpOnly, SameSite=Strict cookie (no Secure on plain HTTP)
    const paired = await pair(base, info.code);
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ ok: true, assistant: 'Pandesh', device: { name: expect.any(String) } });
    const setCookie = paired.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('kkd_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Secure');
    // The token travels only in the HttpOnly cookie, never in a body page script could read.
    const token = decodeURIComponent(paired.cookie.slice('kkd_session='.length));
    expect(JSON.stringify(paired.body)).not.toContain(token);
    const cookieHeader = paired.cookie;

    // 6. Check authenticated session endpoint with cookie
    const authSessionRes = await fetch(`${base}/api/session`, { headers: { Cookie: cookieHeader } });
    expect(authSessionRes.status).toBe(200);
    expect(await authSessionRes.json()).toMatchObject({ ok: true, assistant: 'Pandesh', secure: false });

    // 7. Submit message with session cookie: the phone never takes the desktop composer's staged files
    const submitRes = await fetch(`${base}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ message: 'Hi Pandesh' }),
    });
    expect(submitRes.status).toBe(200);
    const submitData = await submitRes.json();
    expect(session.submitTask).toHaveBeenCalledWith('Hi Pandesh', undefined, undefined, 'mobile', []);
    expect(submitData).toMatchObject({ ok: true, attemptId: 'att-1' });
    expect(submitData.text).toContain('Pandesh response to: Hi Pandesh');

    // 8. Query messages with session cookie (with the conversation they belong to)
    const messagesRes = await fetch(`${base}/api/messages`, { headers: { Cookie: cookieHeader } });
    expect(messagesRes.status).toBe(200);
    const messagesData = await messagesRes.json();
    expect(messagesData.messages).toHaveLength(1);
    expect(messagesData.conversationId).toBe('conv-1');

    // 9. Query snapshot and the phone state with session cookie
    const snapRes = await fetch(`${base}/api/snapshot`, { headers: { Cookie: cookieHeader } });
    expect(snapRes.status).toBe(200);
    expect((await snapRes.json()).folder).toBe('C:\\Projects\\example-app');
    const state = await (await fetch(`${base}/api/state`, { headers: { Cookie: cookieHeader } })).json();
    expect(state).toMatchObject({ coreState: 'connected', model: 'gemma4:12b', workspace: 'example-app', running: false, decision: null });

    // 10a. Unauthenticated artifact content request returns 401
    expect((await fetch(`${base}/api/artifacts/art-image-1/content`)).status).toBe(401);

    // 10b. Authenticated image artifact request returns 200 with correct headers
    const imageRes = await fetch(`${base}/api/artifacts/art-image-1/content`, { headers: { Cookie: cookieHeader } });
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get('content-type')).toBe('image/png');
    expect(imageRes.headers.get('cache-control')).toBe('no-store');
    expect(imageRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(imageRes.headers.get('content-disposition')).toBe('inline');
    expect(imageRes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(Buffer.from(await imageRes.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 10b2. An SVG image artifact must never be served inline — it can execute script with the session cookie
    const svgRes = await fetch(`${base}/api/artifacts/art-svg-1/content`, { headers: { Cookie: cookieHeader } });
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get('content-type')).toBe('image/svg+xml');
    expect(svgRes.headers.get('content-disposition') || '').toMatch(/^attachment;/);
    expect(svgRes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    await svgRes.arrayBuffer();

    // 10c. Authenticated PDF document artifact is served inline as application/pdf
    const pdfRes = await fetch(`${base}/api/artifacts/art-doc-1/content`, { headers: { Cookie: cookieHeader } });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    expect(pdfRes.headers.get('content-disposition')).toBe('inline');
    expect(Buffer.from(await pdfRes.arrayBuffer()).toString()).toBe('%PDF-1.4');

    // 10e. Other document/file artifacts are served as attachment downloads with a sanitized filename
    const fileRes = await fetch(`${base}/api/artifacts/art-file-1/content`, { headers: { Cookie: cookieHeader } });
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-type')).toBe('application/zip');
    const fileDispositionMatch = (fileRes.headers.get('content-disposition') || '').match(/^attachment; filename="([^]*)"$/);
    expect(fileDispositionMatch).not.toBeNull();
    expect(fileDispositionMatch![1]).toBe('Report (final)_draft_.zip');
    await fileRes.arrayBuffer();

    // 10e2. Authenticated HEAD: same headers as GET, no body, and the session gate still applies
    const headRes = await fetch(`${base}/api/artifacts/art-doc-1/content`, { method: 'HEAD', headers: { Cookie: cookieHeader } });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-length')).toBe('8');
    expect(headRes.headers.get('accept-ranges')).toBe('bytes');
    expect((await headRes.arrayBuffer()).byteLength).toBe(0);
    expect((await fetch(`${base}/api/artifacts/art-doc-1/content`, { method: 'HEAD' })).status).toBe(401);

    // 10e3. Byte ranges: bounded, open-ended, suffix, clamped, unsatisfiable and ignored-malformed
    const rangeOf = (range: string, extra: Record<string, string> = {}, method = 'GET') =>
      fetch(`${base}/api/artifacts/art-doc-1/content`, { method, headers: { Cookie: cookieHeader, Range: range, ...extra } });
    const r1 = await rangeOf('bytes=1-3');
    expect(r1.status).toBe(206);
    expect(r1.headers.get('content-range')).toBe('bytes 1-3/8');
    expect(Buffer.from(await r1.arrayBuffer()).toString()).toBe('PDF');
    const r3 = await rangeOf('bytes=-3');
    expect(r3.headers.get('content-range')).toBe('bytes 5-7/8');
    expect(Buffer.from(await r3.arrayBuffer()).toString()).toBe('1.4');
    const r5 = await rangeOf('bytes=8-');
    expect(r5.status).toBe(416);
    await r5.arrayBuffer();
    const r6 = await rangeOf('bytes=0-1,3-4');
    expect(r6.status).toBe(200);
    expect(Buffer.from(await r6.arrayBuffer()).toString()).toBe('%PDF-1.4');
    const r7 = await rangeOf('bytes=1-3', { 'If-Range': '"x"' });
    expect(r7.status).toBe(200);
    await r7.arrayBuffer();

    // 10e4. ?download=1 forces an attachment even for an inline-able PDF
    const dlRes = await fetch(`${base}/api/artifacts/art-doc-1/content?download=1`, { headers: { Cookie: cookieHeader } });
    expect(dlRes.headers.get('content-disposition')).toBe('attachment; filename="Invoice.pdf"');
    await dlRes.arrayBuffer();

    // 10e5. Non-ASCII names: quoted ASCII fallback plus RFC 8187 filename*
    const u8 = await fetch(`${base}/api/artifacts/art-utf8-1/content?download=1`, { headers: { Cookie: cookieHeader } });
    expect(u8.headers.get('content-disposition')).toBe(
      "attachment; filename=\"R_sum_ _ ___ (it's 100_).pdf\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E2%80%93%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%28it%27s%20100%25%29.pdf",
    );
    await u8.arrayBuffer();

    // 10f. Unknown artifact id returns 404 without leaking internal error text
    const missingRes = await fetch(`${base}/api/artifacts/does-not-exist/content`, { headers: { Cookie: cookieHeader } });
    expect(missingRes.status).toBe(404);
    const missingData = await missingRes.json();
    expect(missingData.error).toBe('Not found');
    expect(JSON.stringify(missingData)).not.toContain('secret');

    // 11. Verify safe server diagnostics logs were emitted, and the code never was
    expect(logs).toContain('[MOBILE] pair requested');
    expect(logs).toContain('[MOBILE] pair success');
    expect(logs).toContain('[MOBILE] session recognized');
    expect(logs).toContain('[MOBILE] submit accepted');
    expect(logs).toContain('[MOBILE] result delivered');
    expect(logs).toContain('[MOBILE] messages 200');
    expect(logs.join('\n')).not.toContain(info.code);
    expect(logs.join('\n')).not.toContain(info.code.replace('-', ''));
  });

  it('phone worker approvals need a paired session, are attributed to the phone, and never carry the host token', async () => {
    const decide = vi.fn(async () => ({ ok: true }));
    const { server: mobile, base } = await server({ session: { ...mockSession(), decideDevStoryPermission: decide } });
    const url = `${base}/api/dev-stories/story-1/permissions/pend-1`;
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // No pairing: refused before the host is asked to decide anything.
    expect((await post({}, { allow: true })).status).toBe(401);
    // A client-supplied host token or client id header grants nothing without a paired session.
    expect((await post({ 'X-Host-Token': 'anything', 'X-Client-Id': 'desktop_x' }, { allow: true })).status).toBe(401);
    expect(decide).not.toHaveBeenCalled();

    const { cookie } = await pair(base, mobile.getPairingInfo().code);
    expect(cookie).toMatch(/^kkd_session=/);

    expect((await post({ Cookie: cookie }, { allow: 'yes' })).status).toBe(400);
    const ok = await post({ Cookie: cookie }, { allow: false });
    expect(ok.status).toBe(200);
    // The host-side session, not the phone, attaches the host token; the phone only names itself as the channel.
    expect(decide).toHaveBeenCalledExactlyOnceWith('story-1', 'pend-1', false, 'phone');

    // Nothing the phone can fetch contains the desktop host secret.
    for (const file of ['/', '/app.js', '/lib.js', '/sw.js']) {
      const text = (await (await fetch(`${base}${file}`)).text()).toLowerCase();
      expect(text).not.toContain('host-token');
      expect(text).not.toContain('host.token');
    }
    expect(JSON.stringify(await ok.json())).not.toMatch(/token/i);
  });

  it('after an upgrade, phones paired with an older build must pair again; the log gives only the count', async () => {
    const dataDir = tempDir(dirs);
    const hostToken = 'old-host-token-value-0002';
    const phones = ['old-phone-session-dddd', 'old-phone-session-eeee'];
    fs.writeFileSync(path.join(dataDir, 'mobile-pair.json'), JSON.stringify({ code: 'H7KM', token: hostToken, sessions: [phones[0], hostToken], pairedTokens: [phones[1]] }));
    const { server: mobile, logs, base } = await server({ dataDir });

    expect(logs).toContain('[MOBILE] dropped 2 phone logins from an older build');
    expect(mobile.pairedDevices()).toEqual([]);
    for (const old of [...phones, hostToken]) {
      expect((await fetch(`${base}/api/session`, { headers: { Cookie: `kkd_session=${old}` } })).status).toBe(401);
      expect((await fetch(`${base}/api/events`, { headers: { Cookie: `kkd_session=${old}` } })).status).toBe(401);
    }
    expect((await pair(base, 'H7KM')).status).toBe(401);

    const { code } = mobile.getPairingInfo();
    expect(code).toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
    expect((await pair(base, code)).status).toBe(200);
    const logText = logs.join('\n');
    for (const secret of [...phones, hostToken, 'H7KM', code, code.replace('-', '')]) expect(logText).not.toContain(secret);
  });
});

describe('the phone app renders artifacts from this server only (lib.js markdown)', () => {
  const lib = (() => {
    const sandbox: any = {};
    vm.runInNewContext(fs.readFileSync(mobileFile('lib.js'), 'utf8'), { window: sandbox, globalThis: sandbox });
    return sandbox.PandeshMobileLib;
  })();

  it('an image artifact becomes a same-origin image block (cookie-authenticated, no foreign URL)', () => {
    expect(lib.parseMarkdown('![a generated image](artifact:art-image-1)')).toEqual([{ t: 'img', alt: 'a generated image', id: 'art-image-1' }]);
    const app = fs.readFileSync(mobileFile('app.js'), 'utf8');
    expect(app).toContain("'/api/artifacts/' + encodeURIComponent(b.id) + '/content'");
  });

  it('a document artifact becomes Open and Download controls on the artifact route', () => {
    expect(lib.parseMarkdown('[Invoice.pdf](artifact:art-doc-1)')).toEqual([{ t: 'doc', name: 'Invoice.pdf', id: 'art-doc-1' }]);
    const app = fs.readFileSync(mobileFile('app.js'), 'utf8');
    expect(app).toContain("href + '?download=1'");
    expect(app).toMatch(/text: 'Open'/);
    expect(app).toMatch(/text: 'Download'/);
  });
});
