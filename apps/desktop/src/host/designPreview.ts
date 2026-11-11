/**
 * The Design workshop's preview. A generated page is untrusted content, so it never runs with Pandesh's privileges:
 *
 * - It is served only from memory, by an unguessable short-lived token (`pandesh-preview://<token>/`). The scheme has
 *   no path into the filesystem: a preview cannot read a file, and anything but the page itself is "not found".
 * - Every response carries a policy that allows no network at all (no fetch, images, fonts, frames, forms, base or
 *   workers from anywhere but the page itself and data:) and sandboxes the document even if it were opened on its own.
 * - The window frames it with sandbox="allow-scripts": an opaque origin with no access to the window, its bridge,
 *   storage or cookies, no popups and no top navigation. The window's own policy (frame-src pandesh-preview:) blocks
 *   a frame from going to any other address before a request is made; the main process cancels such a navigation as
 *   a second layer; and the media permission is given to the window itself only, never to a frame.
 * - A small reporter, injected before the page's own content, posts the page's outline (headings and buttons with
 *   their computed sizes), runtime errors and blocked requests to the window, which accepts them only from that frame
 *   with its nonce. What it reports is the page's own content: data for the person, never instructions.
 */
import * as crypto from 'node:crypto';

export const DESIGN_PREVIEW_SCHEME = 'pandesh-preview';
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 24;

export const DESIGN_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts',
].join('; ');

const PREVIEW_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': DESIGN_PREVIEW_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), clipboard-read=(), clipboard-write=()',
};

export function isDesignPreviewUrl(url: string): boolean {
  return url.startsWith(`${DESIGN_PREVIEW_SCHEME}://`);
}

/** The reporter, as the first thing in the page. Plain ES5 so it runs in any page; the nonce is hex. */
export function previewReporter(nonce: string): string {
  return `<script>(function(){var N=${JSON.stringify(nonce)};var P=window.parent;`
    + `function send(k,d){try{P.postMessage({pandeshPreview:N,kind:k,data:d},'*')}catch(e){}}`
    + `window.addEventListener('error',function(e){send('error',{message:String(e.message||'error').slice(0,300),line:e.lineno||0})});`
    + `window.addEventListener('unhandledrejection',function(e){var r=e.reason;send('error',{message:String((r&&r.message)||r||'a promise failed').slice(0,300)})});`
    + `document.addEventListener('securitypolicyviolation',function(e){send('blocked',{directive:String(e.effectiveDirective||e.violatedDirective||''),uri:String(e.blockedURI||'').slice(0,160)})});`
    + `function px(v){return Math.round(parseFloat(v)*10)/10}`
    + `function outline(){var out=[];var ns=document.querySelectorAll('h1,h2,h3,h4,h5,h6,button,a[href],[role=button],input,textarea,select,img');`
    + `for(var i=0;i<ns.length&&out.length<80;i++){var el=ns[i];var cs=getComputedStyle(el);var r=el.getBoundingClientRect();`
    + `out.push({tag:el.tagName.toLowerCase(),text:String(el.innerText||el.value||el.alt||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().slice(0,120),`
    + `href:el.tagName==='A'?String(el.getAttribute('href')||'').slice(0,120):undefined,fontSize:px(cs.fontSize),fontWeight:String(cs.fontWeight),color:cs.color,background:cs.backgroundColor,`
    + `x:Math.round(r.left),y:Math.round(r.top+window.scrollY),width:Math.round(r.width),height:Math.round(r.height),visible:r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'})}`
    + `return {title:String(document.title||'').slice(0,120),viewport:{width:window.innerWidth,height:window.innerHeight},scrollHeight:document.documentElement.scrollHeight,items:out}}`
    + `function report(){try{send('outline',outline())}catch(e){send('error',{message:'outline: '+String(e&&e.message||e)})}}`
    + `var T=0;window.addEventListener('load',report);window.addEventListener('resize',function(){clearTimeout(T);T=setTimeout(report,150)});`
    + `window.addEventListener('message',function(e){if(e.source===P&&e.data&&e.data.pandeshPreview===N&&e.data.kind==='measure')report()});`
    + `})();</script>`;
}

/** The page with the reporter placed before its own content (after <head>, or after <html>, or at the start). */
export function buildPreviewDocument(html: string, nonce: string): string {
  const reporter = previewReporter(nonce);
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + reporter + html.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${reporter}</head>` + html.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + reporter + html.slice(doctype[0].length);
  return reporter + html;
}

interface Entry { document: string; artifactId: string; expires: number }

/** Previews by token, in memory only. Tokens are 128-bit random hex used as the URL's host. */
export class DesignPreviewStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(input: { artifactId: string; html: string }): { url: string; nonce: string; expiresAt: string } {
    this.prune();
    const token = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(12).toString('hex');
    const expires = this.now() + TTL_MS;
    this.entries.set(token, { document: buildPreviewDocument(input.html, nonce), artifactId: input.artifactId, expires });
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
    return { url: `${DESIGN_PREVIEW_SCHEME}://${token}/`, nonce, expiresAt: new Date(expires).toISOString() };
  }

  /** The protocol handler's answer for a request URL: the page, or a plain "not found". */
  respond(requestUrl: string, method = 'GET'): { status: number; headers: Record<string, string>; body: string } {
    const notFound = (text: string) => ({ status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }, body: text });
    if (method !== 'GET') return notFound('Not available in the preview.');
    let parsed: URL;
    try { parsed = new URL(requestUrl); } catch { return notFound('Not available in the preview.'); }
    if (parsed.protocol !== `${DESIGN_PREVIEW_SCHEME}:`) return notFound('Not available in the preview.');
    const entry = this.entries.get(parsed.hostname);
    if (!entry || entry.expires < this.now()) return notFound('This preview has expired. Open the page again in the Workshop.');
    if (parsed.pathname !== '/' && parsed.pathname !== '') return notFound('Only the page itself is part of the preview; it has no other files.');
    return { status: 200, headers: { ...PREVIEW_HEADERS }, body: entry.document };
  }

  size(): number { this.prune(); return this.entries.size; }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expires < now) this.entries.delete(token);
  }
}
