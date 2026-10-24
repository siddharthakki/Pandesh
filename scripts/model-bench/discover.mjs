// Live Ollama discovery (ollama list / ollama show). Kept separate from lib.mjs so lib stays pure.
import { execFileSync } from 'node:child_process';
import { parseOllamaList, parseOllamaShow, classifyModel } from './lib.mjs';

const ollama = args => execFileSync('ollama', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });

export function discoverModels() {
  const listed = parseOllamaList(ollama(['list']));
  return listed.map(model => {
    let show = null;
    let showError = null;
    try { show = parseOllamaShow(ollama(['show', model.name])); } catch (error) { showError = String(error.message ?? error).split('\n')[0]; }
    const { category, reason } = classifyModel(model.name, show);
    return { ...model, category, reason, show, showError };
  });
}
