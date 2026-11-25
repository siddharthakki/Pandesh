import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import type { SecretProtector } from '../../platform/osSecretProtector';
import { createCompanionPairingCode, openCompanionMessage, pairingKey, pairingProof, sealCompanionMessage } from '../../domain/companionSync';

export const protector = (): SecretProtector => {
  const k = crypto.createHash('sha256').update('jugaad-test').digest();
  return {
    kind: 'test store',
    async protect(plain: Buffer) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', k, iv); return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]); },
    async unprotect(blob: Buffer) { const d = crypto.createDecipheriv('aes-256-gcm', k, blob.subarray(0, 12)); d.setAuthTag(blob.subarray(blob.length - 16)); return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]); },
  };
};

export const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

/** A JUGAAD phone speaking the real protocol: TLS to the listener, pinned certificate, sealed calls with nonces. */
export class Phone {
  private key!: Buffer; private fingerprint!: string; private cert!: string;
  constructor(readonly port: number, readonly dir: string, readonly deviceId: string) {}
  private post(urlPath: string, body: unknown, pin: boolean): Promise<{ status: number; json: any; peer: string | null }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const opts: https.RequestOptions = { host: '127.0.0.1', port: this.port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 15_000,
        ...(pin ? { ca: this.cert, checkServerIdentity: (_h: string, c: any) => (c.fingerprint256.replace(/:/g, '').toLowerCase() === this.fingerprint ? undefined : new Error('pin mismatch')) } : { rejectUnauthorized: false }) };
      const req = https.request(opts, (res) => {
        const peer = (res.socket as import('node:tls').TLSSocket).getPeerCertificate?.();
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null, peer: peer?.fingerprint256 ? peer.fingerprint256.replace(/:/g, '').toLowerCase() : null }));
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(data);
    });
  }
  async pair(): Promise<void> {
    const { code } = createCompanionPairingCode();
    const salt = crypto.randomBytes(16); const pk = pairingKey(code, salt);
    const r = await this.post('/companion/v1/pair', { deviceId: this.deviceId, label: 'Test phone', salt: salt.toString('base64'), proof: pairingProof(pk, this.deviceId).toString('base64') }, false);
    if (r.status !== 200) throw new Error(`pairing failed: ${JSON.stringify(r.json)}`);
    const opened = JSON.parse(openCompanionMessage(pk, `${this.deviceId}:pair`, r.json.sealedKey)) as { deviceKey: string; tlsFingerprint: string };
    this.key = Buffer.from(opened.deviceKey, 'base64'); this.fingerprint = opened.tlsFingerprint;
    this.cert = JSON.parse(fs.readFileSync(path.join(this.dir, 'companion-tls.json'), 'utf8')).certPem;
    if (r.peer !== this.fingerprint) throw new Error('certificate pin mismatch at pairing');
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string; http: number }> {
    const nonce = crypto.randomBytes(12).toString('base64url');
    const sealed = sealCompanionMessage(this.key, this.deviceId, JSON.stringify({ method, params, ts: Date.now(), nonce }));
    const r = await this.post('/companion/v1/rpc', { d: this.deviceId, ...sealed }, true);
    if (r.status !== 200) return { ok: false, error: r.json?.error, http: r.status };
    const reply = JSON.parse(openCompanionMessage(this.key, `${this.deviceId}:resp`, r.json.sealed));
    return { ok: reply.ok, result: reply.result, error: reply.error, http: 200 };
  }
  /** Uploads `bytes` in chunks of `chunk` bytes, optionally stopping early (a dropped connection). Returns the last reply. */
  async upload(uploadId: string, name: string, bytes: Buffer, opts: { chunk?: number; stopAfterChunks?: number; startOffset?: number } = {}): Promise<any> {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    let offset = opts.startOffset ?? 0; let sent = 0; let last: any = null;
    for (;;) {
      const data = bytes.subarray(offset, offset + (opts.chunk ?? 40_000));
      const r = await this.call('doc.put', { uploadId, name, size: bytes.length, sha256, offset, data: data.toString('base64') });
      if (!r.ok) return { error: r.error };
      last = r.result; sent += 1;
      if (last.status === 'complete' || last.status === 'duplicate') return last;
      offset = last.received;
      if (opts.stopAfterChunks && sent >= opts.stopAfterChunks) return last;
    }
  }
  async waitTask(taskId: string, ms = 15_000): Promise<any> {
    const end = Date.now() + ms;
    for (;;) {
      const r = await this.call('doc.status', { taskId });
      if (r.ok && ['completed', 'failed', 'cancelled'].includes(r.result.status)) return r.result;
      if (Date.now() > end) throw new Error(`task ${taskId} did not finish: ${JSON.stringify(r)}`);
      await new Promise(res => setTimeout(res, 100));
    }
  }
}

