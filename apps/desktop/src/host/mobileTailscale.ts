/**
 * Where a phone can reach Pandesh Mobile.
 *
 * - The secure link: `tailscale serve` on this PC proxies https://<pc>.<tailnet>.ts.net/ to the phone server. It is
 *   read from `tailscale serve status --json` (read only; Pandesh never changes Tailscale settings). Funnel, which
 *   would publish the server on the public internet, is reported as a problem, never as a link.
 * - The home network link: the PC's address on the local network. Virtual adapters (Hyper-V, WSL, VPNs) and the
 *   Tailscale adapter are skipped, and a private-range address is preferred.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

export type SecureLinkState = 'ready' | 'not-installed' | 'not-running' | 'not-serving' | 'funnel' | 'error';

export interface SecureLinkStatus {
  state: SecureLinkState;
  /** https://<name>/ when state is 'ready'. */
  url: string | null;
  /** One plain sentence for the PC card. */
  detail: string;
}

const LOOPBACK_TARGETS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Does a serve handler's Proxy value point at this port on this PC? ("http://127.0.0.1:3030", "localhost:3030", "3030") */
export function proxyTargetsPort(proxy: unknown, port: number): boolean {
  const value = String(proxy ?? '').trim();
  if (!value) return false;
  if (/^\d{1,5}$/.test(value)) return Number(value) === port;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https+insecure:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const targetPort = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
  return LOOPBACK_TARGETS.has(host) && targetPort === port;
}

/** The serve configs in a status document: the top level, and per-session ones from a foreground `tailscale serve`. */
function serveConfigs(doc: any): any[] {
  if (!doc || typeof doc !== 'object') return [];
  const configs = [doc];
  if (doc.Foreground && typeof doc.Foreground === 'object') {
    for (const fg of Object.values(doc.Foreground)) if (fg && typeof fg === 'object') configs.push(fg);
  }
  return configs;
}

export function parseServeStatus(doc: unknown, port: number): SecureLinkStatus {
  for (const config of serveConfigs(doc)) {
    const web = config && typeof config.Web === 'object' && config.Web ? config.Web as Record<string, any> : {};
    for (const [hostPort, site] of Object.entries(web)) {
      const handlers = site && typeof site.Handlers === 'object' && site.Handlers ? site.Handlers as Record<string, any> : {};
      const root = handlers['/'];
      if (!root || !proxyTargetsPort(root.Proxy, port)) continue;
      const funnel = Boolean(config.AllowFunnel && config.AllowFunnel[hostPort]);
      const m = /^(.+?)(?::(\d{1,5}))?$/.exec(hostPort);
      const host = (m?.[1] ?? hostPort).replace(/\.$/, '').toLowerCase();
      const servePort = m?.[2] ? Number(m[2]) : 443;
      if (!/^[a-z0-9.-]+$/.test(host)) continue;
      if (funnel) {
        return {
          state: 'funnel',
          url: null,
          detail: 'Tailscale Funnel is on for this address, which puts Pandesh on the public internet. Pandesh refuses those requests. Turn it off: tailscale funnel off',
        };
      }
      const url = servePort === 443 ? `https://${host}/` : `https://${host}:${servePort}/`;
      return { state: 'ready', url, detail: `Tailscale serves Pandesh at ${url}` };
    }
  }
  return {
    state: 'not-serving',
    url: null,
    detail: `Tailscale is installed, but nothing serves Pandesh yet. On this PC run: tailscale serve --bg http://127.0.0.1:${port}`,
  };
}

export type TailscaleRunner = (args: string[]) => Promise<{ stdout: string }>;

const WINDOWS_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';

/** Runs the Tailscale command line (read-only calls only). The installed copy first, then PATH. */
export const runTailscaleCli: TailscaleRunner = (args) => new Promise((resolve, reject) => {
  const cli = process.platform === 'win32' && fs.existsSync(WINDOWS_CLI) ? WINDOWS_CLI : 'tailscale';
  execFile(cli, args, { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      e.stderr = String(stderr ?? '');
      reject(e);
      return;
    }
    resolve({ stdout: String(stdout ?? '') });
  });
});

export async function detectSecureLink(port: number, run: TailscaleRunner = runTailscaleCli): Promise<SecureLinkStatus> {
  let stdout: string;
  try {
    ({ stdout } = await run(['serve', 'status', '--json']));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      return { state: 'not-installed', url: null, detail: 'Tailscale is not installed on this PC.' };
    }
    const text = `${e.stderr ?? ''} ${e.message ?? ''}`.toLowerCase();
    if (/stopped|not running|logged out|needslogin|needs login|failed to connect|is tailscale running/.test(text)) {
      return { state: 'not-running', url: null, detail: 'Tailscale is installed but not connected. Open Tailscale on this PC and sign in.' };
    }
    return { state: 'error', url: null, detail: 'Could not read the Tailscale settings on this PC.' };
  }
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === '{}' || trimmed === 'null') return parseServeStatus({}, port);
  try {
    return parseServeStatus(JSON.parse(trimmed), port);
  } catch {
    return { state: 'error', url: null, detail: 'Tailscale answered in a form Pandesh does not understand.' };
  }
}

const SKIPPED_ADAPTERS = /vEthernet|WSL|Hyper-V|virtual|vmware|virtualbox|docker|vpn|loopback|tailscale|zerotier|wireguard|bluetooth|npcap/i;

function isTailscaleRange(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateRange(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The address a phone on the same network would use, or null when the PC has none. */
export function pickLanAddress(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  const candidates: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (SKIPPED_ADAPTERS.test(name)) continue;
    for (const iface of list ?? []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      if (isTailscaleRange(iface.address) || iface.address.startsWith('169.254.')) continue;
      candidates.push(iface.address);
    }
  }
  return candidates.find(isPrivateRange) ?? candidates[0] ?? null;
}
