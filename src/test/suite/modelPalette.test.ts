// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadBuiltinCatalog } from '../../../core/platform/providerCatalog';
import { modelBadges, parseLocalOllamaModels, parseOpenAiCompatibleModels, searchModels, type ModelDescriptor } from '../../../core/platform/modelCatalog';

const media = path.join(__dirname, '../../../media');
const read = (name: string) => fs.readFile(path.join(media, name), 'utf8');
const catalog = loadBuiltinCatalog();
const provider = (id: string) => catalog.providers.find(p => p.id === id)!;

/** What AgentPanel.loadModels posts for a cloud model / local model. */
function pickerEntry(d: ModelDescriptor) {
  if (d.locality === 'local') return { name: d.modelId, modifiedAt: '2026-01-01T00:00:00.000Z' };
  return {
    name: `${d.provider}::${d.modelId}`, label: `${d.modelId} — ${d.providerName} (cloud)`, provider: d.provider, cloud: true as const,
    providerName: d.providerName, displayName: d.displayName, modelId: d.modelId, badges: modelBadges(d), freeness: d.freeness,
    vision: d.vision, tools: d.tools, coding: d.coding, ...(d.contextWindow ? { contextWindow: d.contextWindow } : {}),
  };
}

const local = parseLocalOllamaModels([{ name: 'qwen3.8:27b-mtp-q4_K_M' }, { name: 'gemma4:12b' }]);
const orca = parseOpenAiCompatibleModels(provider('orcarouter'), { data: [{ id: 'deepseek/deepseek-v4-flash-free' }, { id: 'openai/gpt-5.6-sol' }, { id: 'mystery/model-x' }] });
const groq = parseOpenAiCompatibleModels(provider('groq'), { data: [{ id: 'openai/gpt-oss-120b', context_window: 131072 }, { id: 'llama-3.3-70b-versatile' }] });
const or = parseOpenAiCompatibleModels(provider('openrouter'), { data: [
  { id: 'google/gemini-flash:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] },
  { id: 'anthropic/claude-sonnet', pricing: { prompt: '0.000003', completion: '0.000015' }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] },
] });
const ALL = [...local, ...orca, ...groq, ...or];

type PaletteLib = { normalize(e: unknown): Record<string, unknown>; search(models: unknown[], q: unknown): Array<{ key: string }>; humanize(s: string): string };
type KD = { open(): void; close(): void; isOpen(): boolean; models(): unknown[] };

async function mount(): Promise<PaletteLib> {
  const html = await read('chat.html');
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
  let state: Record<string, unknown> = {};
  (window as unknown as { __ollamaAgentVsCodeApi: unknown }).__ollamaAgentVsCodeApi = {
    postMessage: () => undefined, getState: () => state, setState: (next: Record<string, unknown>) => { state = next; },
  };
  for (const file of ['model-palette.js', 'chat-operator-context.js', 'chat-model-palette.js']) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(await read(file))();
  }
  return (window as unknown as { KDModelPalette: PaletteLib }).KDModelPalette;
}

/** What chat.js does with `modelsLoaded`, then the real message so the palette glue and header see it. */
function loadModels(entries: unknown[], keep?: string): void {
  const select = document.getElementById('model-select') as HTMLSelectElement;
  select.innerHTML = '<option value="">Automatic (recommended)</option>';
  for (const m of entries as Array<{ name: string; label?: string; cloud?: boolean; providerName?: string }>) {
    const opt = document.createElement('option');
    opt.value = m.name; opt.textContent = m.label || m.name;
    if (m.cloud) { opt.dataset.cloud = '1'; if (m.providerName) opt.dataset.provider = m.providerName; }
    select.appendChild(opt);
  }
  select.value = '';
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'modelsLoaded', models: entries, selectedModel: keep ?? '' } }));
}
const kd = () => (window as unknown as { __kdModelPalette: KD }).__kdModelPalette;
const q = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const key = (k: string, target: Element = q('.kd-pal-search')) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const rowKeys = () => Array.from(document.querySelectorAll('.kd-pal-row')).map(r => r.getAttribute('data-key'));
const type = (text: string) => { const i = q<HTMLInputElement>('.kd-pal-search'); i.value = text; i.dispatchEvent(new Event('input', { bubbles: true })); };
const chip = (name: string) => (Array.from(document.querySelectorAll('.kd-pal-filters .kd-chip')) as HTMLElement[]).find(c => c.dataset.filter === name)!;

let lib: PaletteLib;
beforeEach(async () => { lib = await mount(); });

describe('model palette (composer)', () => {
  it('search parity: the browser search ranks exactly like core searchModels', () => {
    const entries = ALL.map(pickerEntry).map(lib.normalize);
    for (const text of ['', 'free', 'deepseek', 'free deepseek', 'orcarouter', 'vision', 'groq oss', 'qwen', 'nonexistent']) {
      for (const filters of [[], ['free'], ['cloud', 'tools'], ['local']] as const) {
        const expected = searchModels(ALL, { text, filters: [...filters] }).map(m => (m.locality === 'local' ? m.modelId : `${m.provider}::${m.modelId}`));
        const actual = lib.search(entries, { text, filters: [...filters] }).map(m => m.key);
        expect(actual, `${text}|${filters.join(',')}`).toEqual(expected);
      }
    }
  });

  it('opens a wide dialog with search, all filters, grouping, recommended and Auto first', () => {
    loadModels(ALL.map(pickerEntry));
    q<HTMLButtonElement>('#model-chip').click();
    expect(kd().isOpen()).toBe(true);
    const dialog = q<HTMLElement>('.kd-palette');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(Array.from(document.querySelectorAll('.kd-pal-filters .kd-chip')).map(c => c.textContent)).toEqual(['All', 'Local', 'Cloud', 'Free', 'Vision', 'Coding', 'Tools']);
    expect(document.activeElement).toBe(q('.kd-pal-search'));
    const headers = Array.from(document.querySelectorAll('.kd-pal-header')).map(h => h.textContent);
    expect(headers.join('|')).toMatch(/Recommended/);
    expect(headers.join('|')).toMatch(/Ollama — local/);
    expect(rowKeys()[0]).toBe('');
  });

  it('rows show human name over exact id, provider, and honest badges (unknown is never FREE)', () => {
    loadModels(ALL.map(pickerEntry));
    q<HTMLButtonElement>('#model-chip').click();
    type('deepseek');
    const row = q<HTMLElement>('.kd-pal-row[data-key="orcarouter::deepseek/deepseek-v4-flash-free"]');
    expect(row.querySelector('.kd-pal-primary')!.textContent).toBe('Deepseek V4 Flash');
    expect(row.querySelector('.kd-pal-secondary')!.textContent).toBe('deepseek/deepseek-v4-flash-free');
    expect(row.querySelector('.kd-pal-provider')!.textContent).toBe('OrcaRouter');
    expect(Array.from(row.querySelectorAll('.kd-badge')).map(b => b.textContent)).toEqual(expect.arrayContaining(['CLOUD', 'FREE']));
    type('mystery');
    const unknown = q<HTMLElement>('.kd-pal-row[data-key="orcarouter::mystery/model-x"]');
    const badges = Array.from(unknown.querySelectorAll('.kd-badge')).map(b => b.textContent);
    expect(badges).toContain('CLOUD');
    expect(badges).not.toContain('FREE');
  });

  it('search finds by model, provider and capability; Free filter never shows paid or unknown', () => {
    loadModels(ALL.map(pickerEntry));
    q<HTMLButtonElement>('#model-chip').click();
    type('free deepseek');
    expect(rowKeys()).toEqual(['orcarouter::deepseek/deepseek-v4-flash-free']);
    type('groq');
    expect(rowKeys().every(k => k!.startsWith('groq::'))).toBe(true);
    type('vision');
    expect(rowKeys().sort()).toEqual(['openrouter::anthropic/claude-sonnet', 'openrouter::google/gemini-flash:free']);
    type('');
    chip('free').click();
    const free = rowKeys().filter(Boolean) as string[];
    expect(free.length).toBeGreaterThan(0);
    expect(free).not.toContain('orcarouter::openai/gpt-5.6-sol');
    expect(free).not.toContain('orcarouter::mystery/model-x');
    expect(free).not.toContain('openrouter::anthropic/claude-sonnet');
    expect(free).toContain('orcarouter::deepseek/deepseek-v4-flash-free');
    chip('local').click(); // free + local
    expect(rowKeys().filter(Boolean).every(k => !String(k).includes('::'))).toBe(true);
  });

  it('stays responsive with thousands of models: only a window of rows exists in the DOM', () => {
    const big = parseOpenAiCompatibleModels(provider('openrouter'), { data: Array.from({ length: 6000 }, (_, i) => ({ id: `vendor-${i % 60}/model-${i}`, pricing: { prompt: i % 5 === 0 ? '0' : '0.000001', completion: i % 5 === 0 ? '0' : '0.000001' } })) });
    loadModels([...local, ...big].map(pickerEntry));
    const started = performance.now();
    q<HTMLButtonElement>('#model-chip').click();
    const openMs = performance.now() - started;
    expect(document.querySelectorAll('.kd-pal-row').length).toBeLessThan(60);
    expect(q('.kd-pal-count').textContent).toBe('6002 of 6002 models');
    const list = q<HTMLElement>('.kd-pal-list');
    list.scrollTop = 120_000;
    list.dispatchEvent(new Event('scroll'));
    expect(document.querySelectorAll('.kd-pal-row').length).toBeLessThan(60);
    expect(document.querySelectorAll('.kd-pal-row').length).toBeGreaterThan(3);
    const t2 = performance.now();
    type('vendor-7 model-4');
    expect(performance.now() - t2).toBeLessThan(400);
    expect(openMs).toBeLessThan(600);
    expect(Number(q('.kd-pal-count').textContent!.split(' ')[0])).toBeLessThan(6002);
  });

  it('keyboard: arrows move, Enter selects the exact value, Escape closes without changing anything', () => {
    loadModels(ALL.map(pickerEntry));
    const select = q<HTMLSelectElement>('#model-select');
    let changes = 0;
    select.addEventListener('change', () => { changes++; });
    q<HTMLButtonElement>('#model-chip').click();
    type('deepseek');
    key('ArrowDown'); key('ArrowUp'); // stays on the single match
    key('Enter');
    expect(select.value).toBe('orcarouter::deepseek/deepseek-v4-flash-free');
    expect(changes).toBe(1);
    expect(kd().isOpen()).toBe(false);

    q<HTMLButtonElement>('#model-chip').click();
    key('ArrowDown'); key('ArrowDown');
    key('Escape');
    expect(kd().isOpen()).toBe(false);
    expect(select.value).toBe('orcarouter::deepseek/deepseek-v4-flash-free'); // untouched
    expect(changes).toBe(1);
  });

  it('manual selection is exact, shown readably on the chip, survives a model-list refresh and never turns into another model', () => {
    loadModels(ALL.map(pickerEntry));
    q<HTMLButtonElement>('#model-chip').click();
    type('deepseek');
    q<HTMLElement>('.kd-pal-row[data-key="orcarouter::deepseek/deepseek-v4-flash-free"]').click();
    const select = q<HTMLSelectElement>('#model-select');
    expect(select.value).toBe('orcarouter::deepseek/deepseek-v4-flash-free');
    expect(q('#model-chip-label').textContent).toBe('Deepseek V4 Flash');
    expect(q('#model-chip-icon').textContent).toBe('☁');
    const tip = q<HTMLElement>('#model-chip').title;
    expect(tip).toContain('deepseek/deepseek-v4-flash-free');
    expect(tip).toContain('OrcaRouter');
    expect(tip).toContain('cloud');
    expect(tip).toContain('free');
    expect(q('#oc-provider').textContent).toBe('OrcaRouter / Cloud');
    expect(q('#oc-model').textContent).toBe('deepseek/deepseek-v4-flash-free');

    loadModels(ALL.map(pickerEntry)); // a provider refresh rebuilds the list
    expect(select.value).toBe('orcarouter::deepseek/deepseek-v4-flash-free');

    // Picking Auto hands the choice back; picking a local model is a different exact value.
    q<HTMLButtonElement>('#model-chip').click();
    q<HTMLElement>('.kd-pal-row[data-key=""]').click();
    expect(select.value).toBe('');
    expect(q('#model-chip-label').textContent).toBe('Auto');
    q<HTMLButtonElement>('#model-chip').click();
    type('qwen3.8');
    q<HTMLElement>('.kd-pal-row').click();
    expect(select.value).toBe('qwen3.8:27b-mtp-q4_K_M');
    expect(q('#model-chip-icon').textContent).toBe('◉');
  });

  it('remembers recent models and lists them first next time', () => {
    loadModels(ALL.map(pickerEntry));
    q<HTMLButtonElement>('#model-chip').click();
    type('gemma4');
    q<HTMLElement>('.kd-pal-row').click();
    q<HTMLButtonElement>('#model-chip').click();
    expect(Array.from(document.querySelectorAll('.kd-pal-header')).map(h => h.textContent)[0]).toBe('Recent');
    expect(rowKeys()[1]).toBe('gemma4:12b');
  });
});

describe('supervision and header status (composer owns decisions)', () => {
  it('Hands-off is a supervision policy, separate from mode: choosing it does not touch the mode', () => {
    const mode = q<HTMLSelectElement>('#mode-select');
    const supervision = q<HTMLSelectElement>('#autonomy-mode-select');
    expect(q('#supervision-chip-label').textContent).toBe('Ask me');
    expect(supervision.value).toBe('supervised');
    q<HTMLButtonElement>('#supervision-chip').click();
    q<HTMLElement>('#supervision-popover [data-supervision="hands_off"]').click();
    expect(supervision.value).toBe('hands_off');
    expect(mode.value).toBe('auto');
    expect(q('#supervision-chip-label').textContent).toBe('Hands-off');
    expect(q('#oc-supervision').textContent).toBe('Hands-off');
    expect(q('#oc-mode').textContent).not.toMatch(/hands/i);
    q<HTMLButtonElement>('#supervision-chip').click();
    q<HTMLElement>('#supervision-popover [data-supervision="ask"]').click();
    expect(supervision.value).toBe('supervised');
  });

  it('the header reports the effective mode while the composer owns the selection', async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'modeExecutionStarted', mode: 'autonomous' } }));
    expect(q('#oc-mode').textContent).toBe('Auto → Karke Dikha');
    expect(q<HTMLSelectElement>('#mode-select').value).toBe('auto'); // the header never changed the policy
    expect(document.querySelector('.top-bar #mode-buttons')).not.toBeNull(); // kept for scripts, hidden by CSS
    expect(await read('chat-palette.css')).toMatch(/#mode-buttons\s*\{\s*display:\s*none/);
    // The composer has the decision controls: mode chip, model chip, supervision chip.
    for (const id of ['compact-mode-btn', 'model-chip', 'supervision-chip']) {
      expect(q(`#${id}`).closest('.input-area, .composer, #input-row, #composer-chips, .compact-mode-wrapper, .kd-supervision-wrap')).not.toBeNull();
      expect(q(`#${id}`).closest('.top-bar, #operator-context')).toBeNull();
    }
    expect(Array.from(document.querySelectorAll('.compact-mode-desc')).map(d => d.textContent)).toEqual([
      'KKD decides how to handle each request', 'Understand and explore — no changes', 'Make changes together', 'Execute the task end-to-end',
    ]);
  });

  it('header carries the status fields: workspace, mode, supervision, model, provider, status, plus one compact Config access (no Governance field)', () => {
    const labels = Array.from(document.querySelectorAll('#operator-context .oc-label')).map(l => l.textContent);
    expect(labels).toEqual(['Workspace', 'Mode', 'Supervision', 'Model', 'Thinking', 'Provider', 'Status']);
    expect(document.querySelector('#operator-context #oc-config-btn')?.getAttribute('title')).toBe('Configure KarkeDikha');
    expect(document.querySelector('#operator-context #permission-status-chip')).toBeNull();
  });
});
