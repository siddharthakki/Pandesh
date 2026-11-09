import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODING_AGENTS, discoverCodingAgents, findOnPath, isAgentEnabled, readCodingAgentSettings, spawnPlan } from '../runtime/codingAgents';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-agents-'));
const spec = (id: string) => CODING_AGENTS.find((a) => a.id === id)!;

describe('external coding agents', () => {
  it('local agents are on when installed; cloud agents stay off until the user enables them', () => {
    const none = readCodingAgentSettings(null);
    expect(isAgentEnabled(spec('aider'), none)).toBe(true);
    expect(isAgentEnabled(spec('codex'), none)).toBe(false); // experimental: local mode broken in codex-cli 0.156
    expect(isAgentEnabled(spec('hermes'), none)).toBe(false); // uses its own configuration: opt-in
    expect(isAgentEnabled(spec('claude-code'), none)).toBe(false);
    expect(isAgentEnabled(spec('cline'), none)).toBe(false);
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'coding-agents.json'), JSON.stringify({ enabled: { 'claude-code': true, aider: false } }));
    const s = readCodingAgentSettings(dir);
    expect(isAgentEnabled(spec('claude-code'), s)).toBe(true);
    expect(isAgentEnabled(spec('aider'), s)).toBe(false);
  });

  it('local agents run against the local model and never commit or leave the folder', () => {
    const a = spec('aider').args('Fix the bug', 'D:\\w', 'qwen3.8:27b-mtp-q4_K_M');
    expect(a).toEqual(expect.arrayContaining(['--model', 'ollama_chat/qwen3.8:27b-mtp-q4_K_M', '--message', 'Fix the bug', '--no-git', '--no-auto-commits']));
    const c = spec('codex').args('Build it', 'D:\\w', 'qwen3.8:27b-mtp-q4_K_M');
    expect(c).toEqual(expect.arrayContaining(['exec', '--oss', '--local-provider', 'ollama', '-s', 'workspace-write', '-C', 'D:\\w']));
    expect(c).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(spec('claude-code').dataFlow).toMatch(/Anthropic's cloud/);
  });

  it('discovers only executables really on PATH', () => {
    const bin = tmp();
    const exe = path.join(bin, process.platform === 'win32' ? 'aider.exe' : 'aider');
    fs.writeFileSync(exe, '');
    expect(findOnPath('aider', bin)).toBe(exe);
    expect(findOnPath('codex', bin)).toBeNull();
    const found = discoverCodingAgents(null, bin);
    expect(found.map((a) => a.spec.id)).toEqual(['aider']);
  });

  it('a .cmd shim is run through cmd.exe with every argument quoted and % / newlines neutralised', () => {
    const plan = spawnPlan('C:\\npm\\cline.cmd', ['--json', 'Fix 100% of "it"\n& del *']);
    expect(plan.shellQuoted).toBe(true);
    const line = plan.args[plan.args.length - 1];
    expect(line).toContain('"Fix 100 percent  of ""it"" & del *"');
    expect(line).not.toContain('\n');
    expect(spawnPlan('C:\\bin\\aider.exe', ['-m', 'x'])).toEqual({ file: 'C:\\bin\\aider.exe', args: ['-m', 'x'], shellQuoted: false });
  });
});

import { housekeepingRoot } from '../runtime/codingAgents';
describe('agent housekeeping and Windows console (live run AG1)', () => {
  it('recognises an agent\'s own files and folders, not the user\'s', () => {
    expect(housekeepingRoot('.aider.chat.history.md')).toBe('.aider.chat.history.md');
    expect(housekeepingRoot('.aider.tags.cache.v4/cache.db')).toBe('.aider.tags.cache.v4');
    expect(housekeepingRoot('src/.codex/session.json')).toBe('src/.codex');
    expect(housekeepingRoot('stats_tools.py')).toBeNull();
  });
  it('Aider writes UTF-8 and keeps its history out of the user folder', () => {
    const a = spec('aider');
    expect(a.env?.('m')).toMatchObject({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
    const args = a.args('x', 'D:\\w', 'm');
    const hist = args[args.indexOf('--chat-history-file') + 1];
    expect(hist.startsWith('D:\\w')).toBe(false);
    expect(args).toContain('--no-restore-chat-history');
  });
});
