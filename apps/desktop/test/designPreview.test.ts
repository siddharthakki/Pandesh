/**
 * The Design preview server: pages come from memory by an unguessable token, with a policy that allows no network
 * and sandboxes the document; there is no path into the filesystem, and an expired or unknown token is "not found".
 */
import { describe, expect, it } from 'vitest';
import { DESIGN_PREVIEW_CSP, DesignPreviewStore, buildPreviewDocument, isDesignPreviewUrl, previewReporter } from '../src/host/designPreview';

const PAGE = '<!doctype html><html><head><title>T</title></head><body><h1>Hi</h1><button>Go</button></body></html>';

describe('the Design preview server', () => {
  it('serves the minted page once per token, with a no-network sandbox policy', () => {
    const store = new DesignPreviewStore();
    const { url, nonce } = store.mint({ artifactId: 'art_1', html: PAGE });
    expect(url).toMatch(/^pandesh-preview:\/\/[0-9a-f]{32}\/$/);
    expect(nonce).toMatch(/^[0-9a-f]{24}$/);
    const r = store.respond(url);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(r.headers['Content-Security-Policy']).toBe(DESIGN_PREVIEW_CSP);
    for (const rule of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", 'sandbox allow-scripts']) {
      expect(DESIGN_PREVIEW_CSP).toContain(rule);
    }
    expect(DESIGN_PREVIEW_CSP).not.toMatch(/https?:|\*|'self'/);
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(r.body).toContain('<h1>Hi</h1>');
    expect(r.body).toContain(JSON.stringify(nonce));
  });

  it('has nothing but the page: other paths, other tokens, other methods and other schemes are not found', () => {
    const store = new DesignPreviewStore();
    const { url } = store.mint({ artifactId: 'art_1', html: PAGE });
    expect(store.respond(`${url}style.css`).status).toBe(404);
    expect(store.respond(`${url}..%2F..%2Fcore.db`).status).toBe(404);
    expect(store.respond('pandesh-preview://00000000000000000000000000000000/').status).toBe(404);
    expect(store.respond(url, 'POST').status).toBe(404);
    expect(store.respond('file:///C:/Windows/win.ini').status).toBe(404);
    expect(store.respond('not a url').status).toBe(404);
    expect(store.respond(`${url}x`).headers['Content-Security-Policy']).toMatch(/sandbox/);
  });

  it('forgets a preview after 30 minutes, and keeps at most 24', () => {
    let now = 1_000_000;
    const store = new DesignPreviewStore(() => now);
    const first = store.mint({ artifactId: 'art_1', html: PAGE });
    now += 29 * 60_000;
    expect(store.respond(first.url).status).toBe(200);
    now += 2 * 60_000;
    expect(store.respond(first.url).status).toBe(404);
    const urls = Array.from({ length: 30 }, (_, i) => store.mint({ artifactId: `art_${i}`, html: PAGE }).url);
    expect(store.size()).toBe(24);
    expect(store.respond(urls[0]).status).toBe(404);
    expect(store.respond(urls[29]).status).toBe(200);
  });

  it('places the reporter before the page\'s own content, wherever the page starts', () => {
    const reporter = previewReporter('abc');
    expect(buildPreviewDocument(PAGE, 'abc')).toBe(PAGE.replace('<head>', `<head>${reporter}`));
    expect(buildPreviewDocument('<html lang="en"><body><h1>x</h1></body></html>', 'abc')).toBe(`<html lang="en"><head>${reporter}</head><body><h1>x</h1></body></html>`);
    expect(buildPreviewDocument('<!DOCTYPE html><h1>x</h1>', 'abc')).toBe(`<!DOCTYPE html>${reporter}<h1>x</h1>`);
    expect(buildPreviewDocument('<h1>x</h1>', 'abc')).toBe(`${reporter}<h1>x</h1>`);
    // The reporter only posts to the parent and listens for the parent's "measure"; it reads nothing else.
    expect(reporter).toContain("P.postMessage({pandeshPreview:N,kind:k,data:d},'*')");
    expect(reporter).toContain('e.source===P');
    expect(reporter).toContain('/\\s+/g');
    expect(reporter).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|document\.cookie|window\.desktop/);
  });

  it('recognises preview URLs and nothing else', () => {
    expect(isDesignPreviewUrl('pandesh-preview://0123/')).toBe(true);
    expect(isDesignPreviewUrl('https://example.com/')).toBe(false);
    expect(isDesignPreviewUrl('file:///C:/x.html')).toBe(false);
    expect(isDesignPreviewUrl('')).toBe(false);
  });
});
