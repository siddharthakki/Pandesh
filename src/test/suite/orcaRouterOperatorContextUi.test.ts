// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

const media = path.join(__dirname, '../../../media');
const read = (name: string) => fs.readFile(path.join(media, name), 'utf8');

/**
 * The live legacy webview: a manual OrcaRouter pick must read back as provider "OrcaRouter / Cloud" and the exact
 * model id (never the internal `orcarouter::` picker value), and Auto/local must keep showing the local provider.
 */
async function mount(): Promise<void> {
  const html = await read('chat.html');
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
  (window as unknown as { __ollamaAgentVsCodeApi: unknown }).__ollamaAgentVsCodeApi = {
    postMessage: () => undefined,
    getState: () => ({}),
    setState: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(await read('chat-operator-context.js'))();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(await read('chat-sidebar-ui.js'))();
}

const post = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
const text = (id: string) => document.getElementById(id)!.textContent;

beforeEach(async () => {
  await mount();
  post({ type: 'operatorContext', workspace: { name: 'ws', path: 'C:\\ws' }, provider: 'Local • Ollama', thinking: 'Default', governance: 'Governed' });
});

describe('OrcaRouter in the operator context', () => {
  it('the picker shows the cloud model with its label and, once chosen, names OrcaRouter / Cloud and the exact model', () => {
    const select = document.getElementById('model-select') as HTMLSelectElement;
    select.innerHTML = '<option value="">Automatic</option><option value="orcarouter::acme/model-x">acme/model-x — OrcaRouter (cloud)</option>';
    expect(text('oc-provider')).toBe('Local • Ollama');

    select.value = 'orcarouter::acme/model-x';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('oc-model')).toBe('acme/model-x');
    expect(text('oc-provider')).toBe('OrcaRouter / Cloud');
  });

  it('the host confirmation of a manual cloud turn keeps the exact model and the cloud provider label', () => {
    post({ type: 'modelSuitability', summary: 's', details: { selectedModel: 'acme/model-x', selectedProvider: 'orcarouter', userOverrode: true } });
    expect(text('oc-model')).toBe('acme/model-x');
    expect(text('oc-provider')).toBe('OrcaRouter / Cloud');
  });

  it('returning to Automatic or a local model restores the local provider label', () => {
    const select = document.getElementById('model-select') as HTMLSelectElement;
    select.innerHTML = '<option value="">Automatic</option><option value="orcarouter::acme/model-x">x</option><option value="local:7b">local:7b</option>';
    select.value = 'orcarouter::acme/model-x';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.value = 'local:7b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('oc-model')).toBe('local:7b');
    expect(text('oc-provider')).toBe('Local • Ollama');

    post({ type: 'modelSuitability', summary: 's', details: { selectedModel: 'acme/model-x', selectedProvider: 'orcarouter', userOverrode: true } });
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('oc-provider')).toBe('Local • Ollama');
  });
});
