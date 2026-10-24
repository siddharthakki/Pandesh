import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBrowserCapabilityAdapter } from '../runtime/browserCapability';
import { browserOutputDir, isInsideWorkspace, resolveWorkspacePage } from '../runtime/browserInspection';
import { resolveHostBrowserBin } from '../runtime/hostBrowserBin';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-browser-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body><h1>Tip</h1><button id="go">Go</button></body></html>');
  return root;
}

describe('host-managed browser capability', () => {
  it('prefers KARKEDIKHA_BROWSER_BIN when the file exists', () => {
    const root = tempWorkspace();
    const pinned = path.join(root, 'msedge.exe');
    fs.writeFileSync(pinned, '');
    expect(resolveHostBrowserBin({ KARKEDIKHA_BROWSER_BIN: pinned }, 'win32')).toBe(pinned);
  });

  it('rejects a path outside the workspace without launching a browser', async () => {
    const root = tempWorkspace();
    const runner = async () => {
      throw new Error('runner must not run');
    };
    const adapter = createBrowserCapabilityAdapter({ runner, browserBin: path.join(root, 'msedge.exe') });
    const result = await adapter.run(
      { name: 'inspect_page', arguments: { path: 'C:\\kdikha\\tipcalc-browser-check\\index.html' } },
      { cwd: root },
    );
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('browser_inspect_failed');
    expect(result.output).toMatch(/not a readable workspace file|outside/);
    const recovered = resolveWorkspacePage(root, 'C:\\kdikha\\tipcalc-browser-check\\index.html');
    expect(recovered.ok).toBe(false);
  });

  it('runs the host inspector with a workspace page and workspace temp output', async () => {
    const root = tempWorkspace();
    const outputDir = browserOutputDir(root);
    const screenshotPath = path.join(outputDir, 'desktop.png');
    const adapter = createBrowserCapabilityAdapter({
      browserBin: path.join(root, 'msedge.exe'),
      runner: async (request) => {
        expect(isInsideWorkspace(root, request.outputDir)).toBe(true);
        expect(request.relativePath).toBe('index.html');
        expect(request.viewportWidth).toBe(390);
        fs.mkdirSync(request.outputDir, { recursive: true });
        fs.writeFileSync(path.join(request.outputDir, request.screenshotName), 'png');
        return {
          title: 'Tip',
          url: `http://127.0.0.1:9/${request.relativePath}`,
          viewport: { width: request.viewportWidth, height: request.viewportHeight },
          snapshot: 'Tip\nGo',
          screenshotPath: path.join(request.outputDir, request.screenshotName),
        };
      },
    });
    const result = await adapter.run(
      {
        name: 'inspect_page',
        arguments: {
          path: 'index.html',
          viewportWidth: 390,
          viewportHeight: 844,
          steps: [{ action: 'click', selector: '#go' }],
        },
      },
      { cwd: root },
    );
    expect(result.status).toBe('succeeded');
    expect(result.resultCategory).toBe('browser_inspect_succeeded');
    expect(result.output).toMatch(/Tip/);
    expect(String(result.normalizedArguments?.screenshotPath ?? screenshotPath)).toContain(path.join('.tmp', 'karkedikha-browser'));
  });

  it('reports unavailable when no host browser is pinned or present', () => {
    const adapter = createBrowserCapabilityAdapter({ browserBin: null, env: {} });
    expect(adapter.health().state).toBe('unavailable');
  });

  it('registers inspect_page as a consequential governed tool', () => {
    const registry = new GovernedCapabilityRegistry().register(createBrowserCapabilityAdapter({ browserBin: 'edge' }));
    expect(registry.definitions().map((tool) => tool.name)).toEqual(['inspect_page']);
    expect(registry.classify('inspect_page')).toEqual({ capabilityId: 'browser', risk: 'consequential' });
  });

  it('live-inspects the tip-calculator fixture through the host browser', async () => {
    if (process.env.KARKEDIKHA_LIVE_BROWSER_TEST !== '1') return;
    const fixture = path.resolve('C:\\Projects\\ollama-agent\\.tmp\\tip-calculator');
    const adapter = createBrowserCapabilityAdapter();
    expect(adapter.health().state).toBe('available');
    const desktop = await adapter.run({
      name: 'inspect_page',
      arguments: {
        path: 'index.html',
        viewportWidth: 1280,
        viewportHeight: 800,
        steps: [
          { action: 'click', selector: '#round-up' },
          { action: 'click', selector: 'button[type=submit]' },
        ],
      },
    }, { cwd: fixture });
    expect(desktop.status).toBe('succeeded');
    expect(desktop.output).toMatch(/\$25\.75/);
    expect(desktop.output).toMatch(/19\.08%/);
    const mobile = await adapter.run({
      name: 'inspect_page',
      arguments: {
        path: 'index.html',
        viewportWidth: 390,
        viewportHeight: 844,
        steps: [
          { action: 'fill', selector: '#bill', value: '' },
          { action: 'click', selector: 'button[type=submit]' },
        ],
      },
    }, { cwd: fixture });
    expect(mobile.status).toBe('succeeded');
    expect(mobile.output).toMatch(/Bill amount is required/);
  }, 60_000);
});
