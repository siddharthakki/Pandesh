#!/usr/bin/env node
/**
 * Bounded Ollama model inventory + sequential GPU eval audit.
 * Does NOT delete models or change defaults.
 *
 * Usage:
 *   node scripts/model-inventory-audit.mjs            # inventory only
 *   node scripts/model-inventory-audit.mjs --eval      # inventory + sequential evals
 *   node scripts/model-inventory-audit.mjs --eval --phase=everyday
 *   node scripts/model-inventory-audit.mjs --eval --phase=coding
 *   node scripts/model-inventory-audit.mjs --eval --phase=mtp
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const outDir = path.join(repoRoot, '.acceptance-evidence', 'model-inventory-audit');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const MAX_IDENTICAL_FAILURES = 2;
const NUM_CTX = 8192;
const KEEP_ALIVE = '0'; // unload after each request to free VRAM between models
const TEMPERATURE = 0.2;

const args = new Set(process.argv.slice(2));
const doEval = args.has('--eval');
const phaseArg = [...args].find((a) => a.startsWith('--phase='));
const phase = phaseArg ? phaseArg.slice('--phase='.length) : 'all';

function ensureOut() {
  fs.mkdirSync(outDir, { recursive: true });
}

async function ollama(pathname, body, { method = 'GET', timeoutMs = 120_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`Ollama ${pathname} ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

function nvidiaQuery() {
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return null;
  const [used, total, util] = r.stdout.trim().split(',').map((x) => Number(x.trim()));
  return { usedMiB: used, totalMiB: total, utilPct: util };
}

function gpuApps() {
  const r = spawnSync(
    'nvidia-smi',
    ['--query-compute-apps=pid,process_name,used_gpu_memory', '--format=csv,noheader'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return [];
  return r.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, name, mem] = line.split(',').map((s) => s.trim());
      return { pid, name, mem };
    });
}

function comfyOrHeavyGpuJobPresent(apps) {
  const heavy = /comfy|python\.exe|stable.?diffusion|invokeai|automatic1111/i;
  return apps.filter((a) => heavy.test(a.name) && !/llama-server|ollama/i.test(a.name));
}

async function listModels() {
  const tags = await ollama('/api/tags');
  return (tags.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    modified: m.modified_at,
    family: m.details?.family,
    families: m.details?.families,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    digest: m.digest,
  }));
}

async function showModel(name) {
  try {
    return await ollama('/api/show', { name }, { method: 'POST', timeoutMs: 60_000 });
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function readWorkspaceSettings() {
  const p = path.join(repoRoot, '.vscode', 'settings.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function inspectEmbeddingIndex() {
  const sqlitePath = path.join(repoRoot, '.ollama-agent', 'index', 'repository-intelligence.sqlite');
  const legacyJson = path.join(repoRoot, '.ollama-agent', 'index', 'repository-index.json');
  const result = {
    sqlitePath,
    sqliteExists: fs.existsSync(sqlitePath),
    sqliteBytes: null,
    tables: [],
    embeddingHints: [],
    legacyJsonExists: fs.existsSync(legacyJson),
    legacyJsonBytes: null,
  };
  if (result.sqliteExists) {
    result.sqliteBytes = fs.statSync(sqlitePath).size;
    try {
      const db = new DatabaseSync(sqlitePath, { readOnly: true });
      result.tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
      for (const table of result.tables) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (cols.some((c) => /embed|model|dimension|vector/i.test(c)) || /embed|model|meta|config/i.test(table)) {
          try {
            const rows = db.prepare(`SELECT * FROM ${table} LIMIT 5`).all();
            result.embeddingHints.push({ table, cols, sample: rows });
          } catch (e) {
            result.embeddingHints.push({ table, cols, error: String(e.message || e) });
          }
        }
      }
      for (const table of result.tables) {
        try {
          const cols = db.prepare(`PRAGMA table_info(${table})`).all();
          const textCols = cols.filter((c) => /CHAR|TEXT|CLOB/i.test(c.type) || !c.type).map((c) => c.name);
          for (const col of textCols.slice(0, 6)) {
            const rows = db
              .prepare(`SELECT ${col} AS v FROM ${table} WHERE typeof(${col})='text' AND ${col} LIKE '%embed%' LIMIT 3`)
              .all();
            if (rows.length) result.embeddingHints.push({ table, col, rows });
          }
        } catch {
          /* ignore */
        }
      }
      db.close();
    } catch (e) {
      result.sqliteError = String(e.message || e);
    }
  }
  if (result.legacyJsonExists) {
    result.legacyJsonBytes = fs.statSync(legacyJson).size;
  }
  return result;
}

function dependencyMap(installedNames) {
  const settings = readWorkspaceSettings() || {};
  const pkgDefaults = {
    chatModel: 'qwen2.5:14b',
    codingFallback: 'qwen2.5-coder:1.5b (package.json contribute; Defaults.ts differs)',
    embeddingModel: 'nomic-embed-text',
    codeDefaults: {
      model: 'qwen2.5-coder:14b',
      chatModel: 'qwen2.5-coder:14b',
      codingModel: 'qwen3-coder:30b',
      autocompleteModel: 'qwen2.5-coder:1.5b',
      embeddingModel: 'nomic-embed-text',
      contextWindow: 8192,
    },
  };

  const jarvisWorkspace = {
    source: '.vscode/settings.json',
    'ollama-agent.model': settings['ollama-agent.model'],
    'ollama-agent.chatModel': settings['ollama-agent.chatModel'],
    'ollama-agent.agentModel': settings['ollama-agent.agentModel'],
    'ollama-agent.codingModel': settings['ollama-agent.codingModel'],
    'ollama-agent.editModel': settings['ollama-agent.editModel'],
    'ollama-agent.reviewerModel': settings['ollama-agent.reviewerModel'],
    'ollama-agent.codingFallbackModel': settings['ollama-agent.codingFallbackModel'],
    'ollama-agent.contextWindow': settings['ollama-agent.contextWindow'],
    'ollama-agent.modelRoutingPolicy': settings['ollama-agent.modelRoutingPolicy'],
    'ollama-agent.embeddingModel': settings['ollama-agent.embeddingModel'] ?? '(unset → package default nomic-embed-text)',
  };

  const imageGeneration = {
    source: 'C:\\Projects\\ImageGeneration\\config.py',
    ollama_model_default: 'gemma4:12b',
    ollama_url_default: 'http://127.0.0.1:11434',
    role: 'prompt enhancement / negative prompt (optional; OLLAMA_ENABLED)',
    diffusion: 'ComfyUI checkpoints/LoRAs — not Ollama GGUFs',
  };

  const coreRuntime = {
    KARKEDIKHA_DEFAULT_MODEL_fallback: 'qwen2.5-coder:1.5b',
    desktop_env_override: 'KARKEDIKHA_DESKTOP_MODEL',
    recent_smoke_preferred: 'qwen3.8:27b-mtp-q4_K_M',
  };

  const profiles = {
    'qwen-general-local': 'match /qwen[-_ ]?3\\.(?:6|8)/i → operationalContextLimit 32768, tools openai+qwen-xml, ollama_format',
    'ornith-1.5-35b-a3b-local': 'exact Ornith-1.5-35B-A3B → disableNativeThinking, operationalContextLimit 16384',
    'mistral-devstral-local': 'devstral/mistral → operationalContextLimit 24576',
    'Ornith-1.0-9B': 'NO dedicated profile (falls to generic)',
  };

  const missingConfigured = [];
  for (const key of [
    'ollama-agent.model',
    'ollama-agent.chatModel',
    'ollama-agent.agentModel',
    'ollama-agent.codingModel',
    'ollama-agent.editModel',
    'ollama-agent.reviewerModel',
    'ollama-agent.codingFallbackModel',
  ]) {
    const v = jarvisWorkspace[key];
    if (v && typeof v === 'string' && !installedNames.includes(v) && !installedNames.includes(`${v}:latest`)) {
      missingConfigured.push({ key, model: v });
    }
  }

  return {
    runtime: { ollamaVersion: null, apiBase: OLLAMA },
    jarvisWorkspace,
    packageAndCodeDefaults: pkgDefaults,
    imageGeneration,
    coreRuntime,
    modelProfiles: profiles,
    missingConfigured,
    preserveAlways: [
      'nomic-embed-text:latest',
      'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M',
      'gemma4:12b', // ImageGeneration default + codingFallback
      'qwen3.8:27b-mtp-q4_K_M', // current workspace primary
    ],
  };
}

const EVERYDAY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculate_tip',
      description: 'Calculate tip and total for a restaurant bill.',
      parameters: {
        type: 'object',
        properties: {
          bill_usd: { type: 'number' },
          tip_percent: { type: 'number' },
        },
        required: ['bill_usd', 'tip_percent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run an arbitrary shell command. Do not use unless explicitly asked.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file. Do not use for tip math.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
];

const CODING_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a workspace file by relative path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search filenames for a pattern.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write file contents. Requires explicit approval; do not call unless asked to edit.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
];

function tipCorrect(bill, pct) {
  const tip = Math.round(bill * (pct / 100) * 100) / 100;
  const total = Math.round((bill + tip) * 100) / 100;
  return { tip, total };
}

function scoreEveryday(response) {
  const expected = tipCorrect(42.5, 18);
  const msg = response?.message || {};
  const content = String(msg.content || '');
  const toolCalls = msg.tool_calls || [];
  const toolNames = toolCalls.map((t) => t.function?.name || t.name).filter(Boolean);
  const unauthorized = toolNames.filter((n) => n !== 'calculate_tip');
  const usedTip = toolNames.includes('calculate_tip');
  let tipArgOk = false;
  if (usedTip) {
    const call = toolCalls.find((t) => (t.function?.name || t.name) === 'calculate_tip');
    let args = call?.function?.arguments ?? call?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    tipArgOk = Number(args.bill_usd) === 42.5 && Number(args.tip_percent) === 18;
  }
  const tipMatch = /(?:^|[^\d])(7\.65)\b/.test(content) || content.includes('$7.65');
  const totalMatch = /(?:^|[^\d])(50\.15)\b/.test(content) || content.includes('$50.15');
  // Accept either correct tool call with right args OR correct numbers in text without unauthorized tools
  const correct =
    unauthorized.length === 0 && ((usedTip && tipArgOk) || (tipMatch && totalMatch) || (usedTip && tipArgOk));
  const softCorrect = unauthorized.length === 0 && (usedTip || (tipMatch && totalMatch));
  return {
    correct: Boolean(correct || softCorrect),
    strictCorrect: Boolean(correct),
    unauthorizedToolAttempts: unauthorized,
    toolNames,
    tipArgOk,
    tipMatch,
    totalMatch,
    expected,
    contentPreview: content.slice(0, 400),
  };
}

function scoreCoding(response) {
  const msg = response?.message || {};
  const content = String(msg.content || '');
  const toolCalls = msg.tool_calls || [];
  const toolNames = toolCalls.map((t) => t.function?.name || t.name).filter(Boolean);
  const unauthorized = toolNames.filter((n) => n === 'write_file');
  const readOk = toolNames.includes('read_file');
  let readPathOk = false;
  if (readOk) {
    const call = toolCalls.find((t) => (t.function?.name || t.name) === 'read_file');
    let args = call?.function?.arguments ?? call?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    const p = String(args.path || '');
    readPathOk = /hello\.js$/i.test(p) || p === 'hello.js' || p.endsWith('/hello.js') || p.endsWith('\\hello.js');
  }
  // First turn must request read_file (not write). Mentions of subtraction bug without tools also counted if no unauthorized.
  const understandsBug = /subtract|minus|a\s*-\s*b|should\s*\+|return\s*a\s*\+/i.test(content);
  const correct = unauthorized.length === 0 && (readPathOk || (readOk && !unauthorized.length) || (understandsBug && toolNames.length === 0));
  // Prefer tool protocol: read_file of hello.js, no write
  const protocolOk = unauthorized.length === 0 && readPathOk;
  return {
    correct: Boolean(protocolOk || (unauthorized.length === 0 && (readOk || understandsBug))),
    protocolOk,
    unauthorizedToolAttempts: unauthorized,
    toolNames,
    readPathOk,
    understandsBug,
    contentPreview: content.slice(0, 400),
  };
}

async function unloadAll() {
  const ps = await ollama('/api/ps');
  for (const m of ps.models || []) {
    const name = m.name || m.model;
    if (!name) continue;
    try {
      await ollama('/api/generate', { model: name, keep_alive: 0, prompt: '' }, { method: 'POST', timeoutMs: 30_000 });
    } catch {
      /* ignore */
    }
  }
  // brief settle
  await new Promise((r) => setTimeout(r, 1500));
}

async function runChat({ model, system, user, tools, timeoutMs = 180_000 }) {
  const memBefore = nvidiaQuery();
  const t0 = Date.now();
  let firstTokenMs = null;
  // non-streaming for simpler tool_calls parsing; first-response ≈ completion for short tasks
  const body = {
    model,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature: TEMPERATURE, num_ctx: NUM_CTX },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools,
  };
  let response;
  let error;
  try {
    response = await ollama('/api/chat', body, { method: 'POST', timeoutMs });
    firstTokenMs = Date.now() - t0; // no stream; treat as first+complete latency
  } catch (e) {
    error = String(e.message || e);
  }
  const t1 = Date.now();
  const memAfter = nvidiaQuery();
  const peakMemMiB = Math.max(memBefore?.usedMiB ?? 0, memAfter?.usedMiB ?? 0);
  return {
    model,
    error,
    firstResponseMs: firstTokenMs,
    completionMs: t1 - t0,
    memBefore,
    memAfter,
    peakMemMiB,
    response,
    // MTP / draft hints if present
    draftFields: response
      ? {
          draft_num_predict_option: undefined,
          eval_count: response.eval_count,
          prompt_eval_count: response.prompt_eval_count,
          eval_duration: response.eval_duration,
          load_duration: response.load_duration,
          total_duration: response.total_duration,
          keys: Object.keys(response),
        }
      : null,
  };
}

async function evaluateModelSeries({ name, models, system, user, tools, scorer }) {
  const results = [];
  let identicalFailStreak = 0;
  let lastFailSig = null;
  for (const model of models) {
    console.error(`[eval:${name}] ${model}`);
    await unloadAll();
    const memGate = nvidiaQuery();
    const apps = gpuApps();
    const heavy = comfyOrHeavyGpuJobPresent(apps);
    if (heavy.length) {
      results.push({
        model,
        skipped: true,
        reason: 'heavy_gpu_job',
        heavy,
        memGate,
      });
      break;
    }
    const raw = await runChat({ model, system, user, tools });
    const score = raw.response ? scorer(raw.response) : { correct: false, error: raw.error };
    const entry = { ...raw, score, memGate };
    results.push(entry);

    const failSig = !score.correct
      ? JSON.stringify({
          unauthorized: score.unauthorizedToolAttempts || [],
          tools: score.toolNames || [],
          error: raw.error || null,
          tipMatch: score.tipMatch,
          totalMatch: score.totalMatch,
          protocolOk: score.protocolOk,
          readPathOk: score.readPathOk,
        })
      : null;
    if (failSig) {
      if (failSig === lastFailSig) identicalFailStreak += 1;
      else {
        identicalFailStreak = 1;
        lastFailSig = failSig;
      }
      if (identicalFailStreak >= MAX_IDENTICAL_FAILURES) {
        entry.stopReason = `stopped_after_${MAX_IDENTICAL_FAILURES}_identical_failures`;
        console.error(`[eval:${name}] stop: two identical failures`);
        break;
      }
    } else {
      identicalFailStreak = 0;
      lastFailSig = null;
    }
  }
  return results;
}

async function verifyMtp(model) {
  await unloadAll();
  const show = await showModel(model);
  const params = show?.parameters || '';
  const modelfile = show?.modelfile || '';
  const hasDraftParam =
    /draft_num_predict/i.test(params) ||
    /draft_num_predict/i.test(modelfile) ||
    (typeof params === 'object' && params && 'draft_num_predict' in params);

  // Warm + timed generation; inspect response for draft/speculative fields
  const body = {
    model,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0, num_ctx: 2048, num_predict: 64 },
    messages: [{ role: 'user', content: 'Reply with exactly: MTP_PROBE_OK' }],
  };
  const t0 = Date.now();
  let response;
  let error;
  try {
    response = await ollama('/api/chat', body, { method: 'POST', timeoutMs: 180_000 });
  } catch (e) {
    error = String(e.message || e);
  }
  const ms = Date.now() - t0;
  const keys = response ? Object.keys(response) : [];
  const draftish = keys.filter((k) => /draft|specul|mtp|accept/i.test(k));
  // Also check nested metrics if any
  const metrics = response?.metrics || response?.timings || null;
  return {
    model,
    tagClaimsMtp: /mtp/i.test(model),
    showHasDraftNumPredict: Boolean(hasDraftParam),
    draft_num_predict: typeof params === 'string' ? (params.match(/draft_num_predict\s+(\S+)/i) || [])[1] : params?.draft_num_predict,
    responseKeys: keys,
    draftishResponseKeys: draftish,
    metrics,
    eval_count: response?.eval_count,
    eval_duration: response?.eval_duration,
    tokensPerSec:
      response?.eval_count && response?.eval_duration
        ? response.eval_count / (response.eval_duration / 1e9)
        : null,
    completionMs: ms,
    contentPreview: String(response?.message?.content || '').slice(0, 200),
    error,
    verdict: hasDraftParam
      ? 'PARAMETER_PRESENT_unverified_runtime_accept_stats'
      : 'NO_draft_param_in_show_despite_tag',
  };
}

function buildKeepRemove({ installed, everyday, coding, mtp, deps }) {
  const byName = Object.fromEntries(installed.map((m) => [m.name, m]));
  const keep = new Set(deps.preserveAlways.filter((n) => byName[n] || byName[n.replace(/:latest$/, '')]));
  // always keep configured workspace models
  for (const v of Object.values(deps.jarvisWorkspace)) {
    if (typeof v === 'string' && byName[v]) keep.add(v);
  }
  keep.add('nomic-embed-text:latest');
  if (byName['hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M']) keep.add('hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M');

  const everydayRank = (everyday || [])
    .filter((r) => !r.skipped && r.score)
    .map((r) => ({
      model: r.model,
      correct: r.score.correct,
      unauthorized: r.score.unauthorizedToolAttempts?.length || 0,
      completionMs: r.completionMs,
      peakMemMiB: r.peakMemMiB,
    }));
  const codingRank = (coding || [])
    .filter((r) => !r.skipped && r.score)
    .map((r) => ({
      model: r.model,
      correct: r.score.correct,
      protocolOk: r.score.protocolOk,
      unauthorized: r.score.unauthorizedToolAttempts?.length || 0,
      completionMs: r.completionMs,
      peakMemMiB: r.peakMemMiB,
    }));

  const bestEveryday = everydayRank.filter((r) => r.correct).sort((a, b) => a.completionMs - b.completionMs)[0];
  const bestCoding = codingRank
    .filter((r) => r.correct)
    .sort((a, b) => Number(b.protocolOk) - Number(a.protocolOk) || a.completionMs - b.completionMs)[0];

  if (bestEveryday) keep.add(bestEveryday.model);
  if (bestCoding) keep.add(bestCoding.model);

  const removeCandidates = [];
  const reasons = {};

  for (const m of installed) {
    const n = m.name;
    reasons[n] = [];
    if (keep.has(n)) {
      reasons[n].push('KEEP: dependency or measured winner / configured default');
      continue;
    }
    // embedding / reranker / tiny utility
    if (/embed|reranker/i.test(n)) {
      keep.add(n);
      reasons[n].push('KEEP: embedding/reranker inventory — preserve indexes');
      continue;
    }
    if (/functiongemma/i.test(n)) {
      reasons[n].push('CANDIDATE_REMOVE: no configured Jarvis/ImageGen dependency found');
      removeCandidates.push(n);
      continue;
    }
    if (/BTL-4-Compact|huihui|abliterated|Uncensored/i.test(n)) {
      reasons[n].push('CANDIDATE_REMOVE: no workspace role setting; not in eval set');
      removeCandidates.push(n);
      continue;
    }
    if (/Ornith-1\.0-9B/i.test(n)) {
      reasons[n].push('CANDIDATE_REMOVE: superseded by Ornith 1.5; no production profile');
      removeCandidates.push(n);
      continue;
    }
    if (/qwen2\.5-coder:1\.5b/i.test(n)) {
      reasons[n].push('KEEP_SOFT: Core fallback / smoke scripts still reference; weak for real coding');
      keep.add(n);
      continue;
    }
    if (/qwen3\.6:27b/i.test(n) && bestCoding && !/qwen3\.6/.test(bestCoding.model)) {
      reasons[n].push('CANDIDATE_REMOVE_AFTER_CODING_PICK: older sibling of 3.8 if 3.8 wins coding');
      removeCandidates.push(n);
      continue;
    }
    if (/UD-Q4_K_XL|orcarouter\/Qwen3\.8/i.test(n)) {
      reasons[n].push('DEFER: quantization comparison only after production coding model selected');
      continue;
    }
    if (/NeoHorse/i.test(n)) {
      keep.add(n);
      reasons[n].push('KEEP if installed: everyday candidate');
      continue;
    }
    // coding/everyday candidates that lost
    const e = everydayRank.find((r) => r.model === n);
    const c = codingRank.find((r) => r.model === n);
    if (e && !e.correct && bestEveryday && bestEveryday.model !== n) {
      reasons[n].push(`CANDIDATE_REMOVE: failed everyday eval (${e.unauthorized} unauthorized tools, ${e.completionMs}ms)`);
      removeCandidates.push(n);
      continue;
    }
    if (c && !c.correct && bestCoding && bestCoding.model !== n) {
      reasons[n].push(`CANDIDATE_REMOVE: failed coding eval`);
      removeCandidates.push(n);
      continue;
    }
    if (c && c.correct && bestCoding && bestCoding.model !== n) {
      reasons[n].push(`CANDIDATE_REMOVE: coding correct but slower/worse protocol than ${bestCoding.model}`);
      removeCandidates.push(n);
      continue;
    }
    if (e && e.correct && bestEveryday && bestEveryday.model !== n) {
      reasons[n].push(`CANDIDATE_REMOVE: everyday correct but slower than ${bestEveryday.model}`);
      removeCandidates.push(n);
      continue;
    }
    reasons[n].push('REVIEW: no automatic verdict — check deps manually');
  }

  return {
    keep: [...keep].sort(),
    removeCandidates: [...new Set(removeCandidates)].sort(),
    reasons,
    bestEveryday: bestEveryday || null,
    bestCoding: bestCoding || null,
    mtp,
    note: 'No deletions performed. Quantization bake-off deferred until coding winner locked. NeoHorse absent from inventory.',
  };
}

async function main() {
  ensureOut();
  const versionR = spawnSync('ollama', ['--version'], { encoding: 'utf8' });
  const ollamaVersion = (versionR.stdout || versionR.stderr || '').trim();
  const installed = await listModels();
  const installedNames = installed.map((m) => m.name);
  const deps = dependencyMap(installedNames);
  deps.runtime.ollamaVersion = ollamaVersion;

  const detailNames = [
    ...new Set([
      'gemma4:12b',
      'gemma4:26b',
      'qwen3.8:27b-mtp-q4_K_M',
      'laguna-xs-2.1:latest',
      'hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M',
      'devstral-small-2:latest',
      'nomic-embed-text:latest',
      'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M',
      'hf.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0',
      'qwen2.5-coder:1.5b',
      'qwen3.6:27b',
      'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
      'orcarouter/Qwen3.8-27B-Uncensored:Q4_K_M',
      'functiongemma:270m',
      'hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:latest',
    ]),
  ];
  const details = {};
  for (const name of detailNames) {
    if (!installedNames.includes(name)) {
      details[name] = { missing: true };
      continue;
    }
    const show = await showModel(name);
    details[name] = {
      missing: false,
      modelinfo_keys: show.model_info ? Object.keys(show.model_info).slice(0, 30) : [],
      parameters: show.parameters,
      template: typeof show.template === 'string' ? show.template.slice(0, 500) : show.template,
      details: show.details,
      capabilities: show.capabilities,
      projector_info: show.projector_info ? Object.keys(show.projector_info) : undefined,
      requires: show.details?.families,
      // num_ctx from model_info if present
      context_length:
        show.model_info?.['qwen35.context_length'] ||
        show.model_info?.['gemma4.context_length'] ||
        show.model_info?.['mistral3.context_length'] ||
        show.model_info?.['llama.context_length'] ||
        show.model_info?.['nomic-bert.context_length'] ||
        Object.entries(show.model_info || {}).find(([k]) => /context_length$/i.test(k))?.[1],
    };
  }

  const neoHorseInstalled = installedNames.some((n) => /neohorse/i.test(n));
  const embeddingIndex = inspectEmbeddingIndex();
  const apps = gpuApps();
  const gpu = { snapshot: nvidiaQuery(), apps, heavyNonOllama: comfyOrHeavyGpuJobPresent(apps) };
  const loaded = await ollama('/api/ps');

  const inventory = {
    stamp,
    ollamaVersion,
    apiBase: OLLAMA,
    gpu,
    loaded,
    installed,
    neoHorseInstalled,
    neoHorseNote: neoHorseInstalled
      ? 'Present — include in everyday eval after compatibility check'
      : 'NOT INSTALLED — everyday eval skips NeoHorse-1-9B Q5_K_M; compatibility not verified',
    details,
    dependencies: deps,
    embeddingIndex,
    evalNumCtx: NUM_CTX,
    evalTemperature: TEMPERATURE,
  };

  const invPath = path.join(outDir, `inventory-${stamp}.json`);
  fs.writeFileSync(invPath, JSON.stringify(inventory, null, 2));
  fs.writeFileSync(path.join(outDir, 'inventory-latest.json'), JSON.stringify(inventory, null, 2));
  console.log(JSON.stringify({ ok: true, phase: 'inventory', invPath, modelCount: installed.length, neoHorseInstalled }, null, 2));

  if (!doEval) return;

  if (gpu.heavyNonOllama.length) {
    const skipPath = path.join(outDir, `eval-skipped-gpu-${stamp}.json`);
    fs.writeFileSync(skipPath, JSON.stringify({ reason: 'heavy_gpu_job', gpu }, null, 2));
    console.error('GPU contended by non-Ollama job; eval skipped');
    process.exit(2);
  }

  // Reclaim idle keep-alive before evals
  await unloadAll();

  const everydaySystem =
    'You are an everyday assistant. For tip calculations, call calculate_tip with bill_usd and tip_percent. Never call run_shell or write_file for math questions.';
  const everydayUser = 'What is an 18% tip on a $42.50 bill? Give tip and total in USD.';

  const codingSystem =
    'You are a coding agent. The workspace file hello.js exists. On the first turn, call read_file with path "hello.js" to inspect it. Do NOT call write_file. Do not invent other tools.';
  const codingUser =
    'hello.js currently has: function add(a, b) { return a - b; } — Confirm the bug by reading the file with the read_file tool. Do not edit yet.';

  let everyday = null;
  let coding = null;
  let mtp = null;

  const everydayModels = ['gemma4:12b', 'gemma4:26b'].filter((n) => installedNames.includes(n));
  // NeoHorse only if installed
  const neo = installedNames.find((n) => /neohorse/i.test(n));
  if (neo) everydayModels.push(neo);

  const codingModels = [
    'qwen3.8:27b-mtp-q4_K_M',
    'laguna-xs-2.1:latest',
    'hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M',
    'devstral-small-2:latest',
  ].filter((n) => installedNames.includes(n));

  if (phase === 'all' || phase === 'everyday') {
    everyday = await evaluateModelSeries({
      name: 'everyday',
      models: everydayModels,
      system: everydaySystem,
      user: everydayUser,
      tools: EVERYDAY_TOOLS,
      scorer: scoreEveryday,
    });
    fs.writeFileSync(path.join(outDir, `everyday-${stamp}.json`), JSON.stringify(everyday, null, 2));
  }

  if (phase === 'all' || phase === 'coding') {
    coding = await evaluateModelSeries({
      name: 'coding',
      models: codingModels,
      system: codingSystem,
      user: codingUser,
      tools: CODING_TOOLS,
      scorer: scoreCoding,
    });
    fs.writeFileSync(path.join(outDir, `coding-${stamp}.json`), JSON.stringify(coding, null, 2));
  }

  // MTP check on the tagged model after coding phase (or alone)
  if (phase === 'all' || phase === 'mtp' || phase === 'coding') {
    if (installedNames.includes('qwen3.8:27b-mtp-q4_K_M')) {
      mtp = await verifyMtp('qwen3.8:27b-mtp-q4_K_M');
      // Also compare draft param presence on non-MTP siblings without full quant bake-off
      const siblings = ['qwen3.6:27b', 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL', 'orcarouter/Qwen3.8-27B-Uncensored:Q4_K_M'];
      mtp.siblings = {};
      for (const s of siblings) {
        if (!installedNames.includes(s)) continue;
        const show = await showModel(s);
        const params = show?.parameters || '';
        mtp.siblings[s] = {
          draft_num_predict: typeof params === 'string' ? (params.match(/draft_num_predict\s+(\S+)/i) || [])[1] || null : null,
          tagClaimsMtp: /mtp/i.test(s),
        };
      }
      fs.writeFileSync(path.join(outDir, `mtp-${stamp}.json`), JSON.stringify(mtp, null, 2));
    }
  }

  // Load prior phase files if running partial
  if (!everyday && fs.existsSync(path.join(outDir, 'everyday-latest.json'))) {
    everyday = JSON.parse(fs.readFileSync(path.join(outDir, 'everyday-latest.json'), 'utf8'));
  }
  if (!coding && fs.existsSync(path.join(outDir, 'coding-latest.json'))) {
    coding = JSON.parse(fs.readFileSync(path.join(outDir, 'coding-latest.json'), 'utf8'));
  }
  if (everyday) fs.writeFileSync(path.join(outDir, 'everyday-latest.json'), JSON.stringify(everyday, null, 2));
  if (coding) fs.writeFileSync(path.join(outDir, 'coding-latest.json'), JSON.stringify(coding, null, 2));

  const verdict = buildKeepRemove({ installed, everyday, coding, mtp, deps });
  const report = {
    stamp,
    ollamaVersion,
    neoHorseInstalled,
    everyday,
    coding,
    mtp,
    verdict,
    note: 'Defaults unchanged. No models deleted.',
  };
  const reportPath = path.join(outDir, `report-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'report-latest.json'), JSON.stringify(report, null, 2));

  // Markdown summary for operator
  const md = [];
  md.push(`# Model inventory audit (${stamp})`);
  md.push('');
  md.push(`Ollama ${ollamaVersion}. num_ctx=${NUM_CTX}, temperature=${TEMPERATURE}, keep_alive=0.`);
  md.push('');
  md.push('## Dependencies (preserve)');
  md.push(`- Jarvis workspace primary: \`${deps.jarvisWorkspace['ollama-agent.chatModel']}\``);
  md.push(`- Jarvis codingFallback: \`${deps.jarvisWorkspace['ollama-agent.codingFallbackModel']}\``);
  md.push(`- ImageGeneration OLLAMA_MODEL default: \`gemma4:12b\``);
  md.push(`- Embedding default: \`nomic-embed-text\` (index sqlite ${embeddingIndex.sqliteBytes} bytes)`);
  md.push(`- NeoHorse-1-9B Q5_K_M: **${neoHorseInstalled ? 'installed' : 'NOT installed'}**`);
  md.push('');
  md.push('## Everyday results');
  for (const r of everyday || []) {
    md.push(
      `- \`${r.model}\`: correct=${r.score?.correct} tools=${JSON.stringify(r.score?.toolNames)} unauthorized=${JSON.stringify(r.score?.unauthorizedToolAttempts)} firstMs=${r.firstResponseMs} completeMs=${r.completionMs} peakMiB=${r.peakMemMiB}${r.error ? ` ERROR ${r.error}` : ''}`,
    );
  }
  md.push('');
  md.push('## Coding results');
  for (const r of coding || []) {
    md.push(
      `- \`${r.model}\`: correct=${r.score?.correct} protocolOk=${r.score?.protocolOk} tools=${JSON.stringify(r.score?.toolNames)} unauthorized=${JSON.stringify(r.score?.unauthorizedToolAttempts)} firstMs=${r.firstResponseMs} completeMs=${r.completionMs} peakMiB=${r.peakMemMiB}${r.error ? ` ERROR ${r.error}` : ''}`,
    );
  }
  md.push('');
  md.push('## MTP');
  md.push('```json');
  md.push(JSON.stringify(mtp, null, 2));
  md.push('```');
  md.push('');
  md.push('## Keep');
  for (const k of verdict.keep) md.push(`- \`${k}\``);
  md.push('');
  md.push('## Remove candidates (not deleted)');
  for (const k of verdict.removeCandidates) md.push(`- \`${k}\`: ${verdict.reasons[k]?.join('; ')}`);
  md.push('');
  md.push('## All reasons');
  for (const [k, v] of Object.entries(verdict.reasons)) md.push(`- \`${k}\`: ${v.join('; ')}`);
  const mdPath = path.join(outDir, `report-${stamp}.md`);
  fs.writeFileSync(mdPath, md.join('\n'));
  fs.writeFileSync(path.join(outDir, 'report-latest.md'), md.join('\n'));

  console.log(JSON.stringify({ ok: true, reportPath, mdPath, verdict: { keep: verdict.keep, removeCandidates: verdict.removeCandidates, bestEveryday: verdict.bestEveryday, bestCoding: verdict.bestCoding } }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
