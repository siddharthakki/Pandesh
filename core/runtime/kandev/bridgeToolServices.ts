/**
 * Deterministic services that wrap tools already installed on this PC (no model, no network, no install).
 * Each runs a fixed executable with an argument array (never a shell), inside the registered roots, with a timeout and
 * the bridge's cancel signal. If the executable is missing the service is not registered, so it is never offered.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveInsideRoots, type BridgeService, type ServiceRegistry } from './bridgeServices';

export function findExecutable(name: string, extraDirs: string[] = []): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean);
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, name + e);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function run(exe: string, args: string[], signal: AbortSignal, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(exe, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      if (err) {
        if (signal.aborted) return reject(new Error('cancelled'));
        return reject(new Error(`${path.basename(exe)} failed: ${(stderr || err.message).toString().slice(0, 300)}`));
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });
}

const MAX_CHARS = 200_000;

export function pdfTextService(roots: string[], exe: string): BridgeService {
  return {
    id: 'doc.pdf-text', label: 'PDF text extraction (Poppler, read-only)', readOnly: true, taskClasses: ['document.extract'], roots,
    async run({ args, signal }) {
      const p = resolveInsideRoots(args.path, roots);
      if (!/\.pdf$/i.test(p)) throw new Error('args.path must be a .pdf file');
      const { stdout } = await run(exe, ['-layout', '-enc', 'UTF-8', p, '-'], signal, 60_000);
      const text = stdout.slice(0, MAX_CHARS);
      const chars = text.replace(/\s/g, '').length;
      if (chars === 0) throw new Error('no text layer found (a scan?); use the OCR service');
      return { summary: `Extracted ${chars} characters${stdout.length > MAX_CHARS ? ' (truncated)' : ''}`, evidence: { kind: 'pdf-text', chars, truncated: stdout.length > MAX_CHARS, text: text.slice(0, 1500) } };
    },
  };
}

export function ocrService(roots: string[], exe: string): BridgeService {
  return {
    id: 'doc.ocr', label: 'OCR (Tesseract, read-only)', readOnly: true, taskClasses: ['ocr'], roots,
    async run({ args, signal }) {
      const p = resolveInsideRoots(args.path, roots);
      if (!/\.(png|jpe?g|tiff?|bmp)$/i.test(p)) throw new Error('args.path must be an image (png, jpg, tiff, bmp)');
      const lang = typeof args.lang === 'string' && /^[a-z]{3}(\+[a-z]{3})*$/.test(args.lang) ? args.lang : 'eng';
      const { stdout } = await run(exe, [p, 'stdout', '-l', lang], signal, 120_000);
      const text = stdout.slice(0, MAX_CHARS).trim();
      if (!text) throw new Error('OCR found no text');
      return { summary: `Recognised ${text.length} characters`, evidence: { kind: 'ocr', lang, chars: text.length, text: text.slice(0, 1500) } };
    },
  };
}

export function pdfOcrService(roots: string[], pdftoppm: string, tesseract: string): BridgeService {
  return {
    id: 'doc.pdf-ocr', label: 'PDF OCR for scans (Poppler + Tesseract, read-only)', readOnly: true, taskClasses: ['ocr.pdf'], roots,
    async run({ args, signal }) {
      const p = resolveInsideRoots(args.path, roots);
      if (!/\.pdf$/i.test(p)) throw new Error('args.path must be a .pdf file');
      const pages = Math.min(10, Math.max(1, Number.isInteger(args.pages) ? Number(args.pages) : 3));
      const lang = typeof args.lang === 'string' && /^[a-z]{3}(\+[a-z]{3})*$/.test(args.lang) ? args.lang : 'eng';
      // Rendered pages live in a private temp folder that only this run creates and removes.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-ocr-'));
      try {
        await run(pdftoppm, ['-r', '200', '-png', '-f', '1', '-l', String(pages), p, path.join(tmp, 'page')], signal, 120_000);
        const images = fs.readdirSync(tmp).filter(f => f.endsWith('.png')).sort();
        if (images.length === 0) throw new Error('the PDF produced no page images');
        const texts: string[] = [];
        for (const img of images) texts.push((await run(tesseract, [path.join(tmp, img), 'stdout', '-l', lang], signal, 120_000)).stdout.trim());
        const text = texts.join('\n\n').slice(0, MAX_CHARS);
        if (!text.trim()) throw new Error('OCR found no text');
        return { summary: `Recognised ${text.length} characters on ${images.length} page(s)`, evidence: { kind: 'pdf-ocr', pages: images.length, lang, chars: text.length, text: text.slice(0, 1500) } };
      } finally {
        for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
        fs.rmdirSync(tmp);
      }
    },
  };
}

/** Read-only network status of this PC's Tailscale: state and counts only, never addresses or peer details. */
export function tailscaleStatusService(exe: string, baseArgs: string[] = []): BridgeService {
  return {
    id: 'net.tailscale-status', label: 'Tailscale status (read-only)', readOnly: true, taskClasses: ['network.status'], roots: [],
    async run({ signal }) {
      const { stdout } = await run(exe, [...baseArgs, 'status', '--json'], signal, 15_000);
      let j: { BackendState?: string; Self?: { DNSName?: string; Online?: boolean }; Peer?: Record<string, { Online?: boolean }> };
      try { j = JSON.parse(stdout); } catch { throw new Error('tailscale returned unreadable status'); }
      const state = String(j.BackendState ?? 'unknown');
      if (state !== 'Running') throw new Error(`Tailscale is not running (state: ${state})`);
      const peers = Object.values(j.Peer ?? {});
      return {
        summary: `Tailscale running, ${peers.filter(x => x.Online).length}/${peers.length} peers online`,
        evidence: { kind: 'tailscale', backendState: state, self: String(j.Self?.DNSName ?? '').replace(/\.$/, '') || null, selfOnline: j.Self?.Online ?? null, peers: { total: peers.length, online: peers.filter(x => x.Online).length } },
      };
    },
  };
}

/** Registers every tool-backed service whose executable is actually present. Returns what was registered and what was skipped. */
export function registerToolServices(reg: ServiceRegistry, roots: string[], finder: (n: string) => string | null = findExecutable): { registered: string[]; skipped: string[] } {
  const registered: string[] = [], skipped: string[] = [];
  const pdftotext = finder('pdftotext');
  if (pdftotext) { reg.register(pdfTextService(roots, pdftotext)); registered.push('doc.pdf-text'); } else skipped.push('doc.pdf-text (pdftotext not found)');
  const tesseract = finder('tesseract');
  if (tesseract) { reg.register(ocrService(roots, tesseract)); registered.push('doc.ocr'); } else skipped.push('doc.ocr (tesseract not found)');
  const pdftoppm = finder('pdftoppm');
  if (pdftoppm && tesseract) { reg.register(pdfOcrService(roots, pdftoppm, tesseract)); registered.push('doc.pdf-ocr'); } else skipped.push('doc.pdf-ocr (pdftoppm or tesseract not found)');
  const tailscale = finder('tailscale');
  if (tailscale) { reg.register(tailscaleStatusService(tailscale)); registered.push('net.tailscale-status'); } else skipped.push('net.tailscale-status (tailscale not found)');
  return { registered, skipped };
}
