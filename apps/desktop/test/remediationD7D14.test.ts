/**
 * Reliability remediation: D7 (Core's model calls and the host's probes used
 * different Ollama addresses) and D14 (instruction text reached the image prompt).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDesktopCoreExtraEnv, resolveDesktopProviderConfig } from '../src/host/desktopConfig';
import { extractImageGenerationPrompt } from '../src/host/desktopInteractionRouting';

describe('D7: one Ollama address for host and Core', () => {
  it('an address the app was started with reaches Core when no setting overrides it', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-d7-'));
    try {
      const config = resolveDesktopProviderConfig({
        productRoot: empty, homedir: empty, appdata: empty,
        env: { KARKEDIKHA_OLLAMA_URL: 'http://127.0.0.1:11555/' } as NodeJS.ProcessEnv,
      });
      expect(config.apiBase).toBe('http://127.0.0.1:11555');
      const env = buildDesktopCoreExtraEnv({ ollamaModel: 'gemma4:12b', ollamaApiBase: config.apiBase, openRouterModel: null, openRouterMaxUsd: null, openRouterApiKey: null });
      expect(env.KARKEDIKHA_OLLAMA_URL).toBe('http://127.0.0.1:11555');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('D14: image prompt is the picture, not the instructions', () => {
  it('drops "using my local image-generation tools" and the save sentence (audit M11 prompt)', () => {
    const prompt = extractImageGenerationPrompt('Create a realistic image of a steaming plate of chicken biryani with raita, using my local image-generation tools. Save the resulting image so I can view it.');
    expect(prompt).toBe('realistic, a steaming plate of chicken biryani with raita');
  });

  it('keeps descriptive follow-up sentences', () => {
    expect(extractImageGenerationPrompt('generate an image of a cute panda eating dosa. Indian dosa.')).toContain('Indian dosa');
  });
});

describe('D7 precedence (re-run F1)', () => {
  it('a launch-time address beats the editor setting', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-d7b-'));
    try {
      const userDir = path.join(home, 'Code', 'User');
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({ 'ollama-agent.apiBase': 'http://127.0.0.1:11434' }));
      const base = { productRoot: home, homedir: home, appdata: home };
      expect(resolveDesktopProviderConfig({ ...base, env: {} as NodeJS.ProcessEnv }).apiBase).toBe('http://127.0.0.1:11434');
      expect(resolveDesktopProviderConfig({ ...base, env: { KARKEDIKHA_OLLAMA_URL: 'http://127.0.0.1:11555' } as NodeJS.ProcessEnv }).apiBase).toBe('http://127.0.0.1:11555');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
