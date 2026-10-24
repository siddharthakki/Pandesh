#!/usr/bin/env node
/**
 * Qwen quantization bake-off — run only after production coding model is selected.
 * Identical coding task to model-inventory-audit.mjs. Does not delete models.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const outDir = path.join(repoRoot, '.acceptance-evidence', 'model-inventory-audit');
const NUM_CTX = 8192;

const models = [
  'qwen3.8:27b-mtp-q4_K_M',
  'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
  'orcarouter/Qwen3.8-27B-Uncensored:Q4_K_M',
  'qwen3.6:27b',
];

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a workspace file by relative path.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write file. Do not call.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
];

const system =
  'You are a coding agent. The workspace file hello.js exists. On the first turn, call read_file with path "hello.js" to inspect it. Do NOT call write_file.';
const user =
  'hello.js currently has: function add(a, b) { return a - b; } — Confirm the bug by reading the file with the read_file tool. Do not edit yet.';

async function ollama(pathname, body, timeoutMs = 180_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const j = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300));
    return j;
  } finally {
    clearTimeout(t);
  }
}

function nvidiaUsedMiB() {
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
    { encoding: 'utf8' },
  );
  return Number(r.stdout.trim());
}

async function unload() {
  const ps = await ollama('/api/ps');
  for (const m of ps.models || []) {
    try {
      await ollama('/api/generate', { model: m.name || m.model, keep_alive: 0, prompt: '' }, 30_000);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}

function score(resp) {
  const msg = resp?.message || {};
  const toolCalls = msg.tool_calls || [];
  const names = toolCalls.map((t) => t.function?.name || t.name).filter(Boolean);
  const unauthorized = names.filter((n) => n === 'write_file');
  const read = toolCalls.find((t) => (t.function?.name || t.name) === 'read_file');
  let args = read?.function?.arguments ?? read?.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  const p = String(args.path || '');
  const pathOk = /hello\.js$/i.test(p) || p === 'hello.js';
  return {
    correct: unauthorized.length === 0 && pathOk,
    protocolOk: unauthorized.length === 0 && pathOk,
    toolNames: names,
    unauthorized,
    path: args.path,
    content: String(msg.content || '').slice(0, 200),
  };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const model of models) {
    console.error('[quant]', model);
    await unload();
    const mem0 = nvidiaUsedMiB();
    const t0 = Date.now();
    let response;
    let error;
    let peak = mem0;
    const poll = setInterval(() => {
      const m = nvidiaUsedMiB();
      if (m > peak) peak = m;
    }, 500);
    try {
      response = await ollama('/api/chat', {
        model,
        stream: false,
        keep_alive: 0,
        options: { temperature: 0.2, num_ctx: NUM_CTX },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        tools,
      });
    } catch (e) {
      error = String(e.message || e);
    }
    clearInterval(poll);
    const ms = Date.now() - t0;
    const mem1 = nvidiaUsedMiB();
    peak = Math.max(peak, mem1);
    const sc = response ? score(response) : { correct: false };
    let draft_num_predict = null;
    try {
      const show = await ollama('/api/show', { name: model });
      const params = show.parameters || '';
      draft_num_predict = (String(params).match(/draft_num_predict\s+(\S+)/i) || [])[1] || null;
    } catch {
      /* ignore */
    }
    const entry = {
      model,
      error,
      completionMs: ms,
      peakMemMiB: peak,
      memBefore: mem0,
      memAfter: mem1,
      eval_count: response?.eval_count,
      eval_duration: response?.eval_duration,
      tps:
        response?.eval_count && response?.eval_duration
          ? response.eval_count / (response.eval_duration / 1e9)
          : null,
      draft_num_predict,
      score: sc,
    };
    results.push(entry);
    console.error(
      JSON.stringify({
        model,
        ok: sc.correct,
        ms,
        peak,
        tps: entry.tps,
        draft: draft_num_predict,
        tools: sc.toolNames,
        err: error,
      }),
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const winner = results.filter((r) => r.score?.correct).sort((a, b) => a.completionMs - b.completionMs)[0];
  const payload = { stamp, winner: winner?.model ?? null, results };
  fs.writeFileSync(path.join(outDir, `qwen-quant-${stamp}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, 'qwen-quant-latest.json'), JSON.stringify(payload, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        winner: winner?.model ?? null,
        results: results.map((r) => ({
          model: r.model,
          correct: r.score?.correct,
          ms: r.completionMs,
          peak: r.peakMemMiB,
          tps: r.tps,
          draft: r.draft_num_predict,
          tools: r.score?.toolNames,
          err: r.error,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
