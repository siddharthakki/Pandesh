/**
 * End-to-end acceptance with a LOCAL Ollama model: a real tool-calling loop over the real ToolRegistry, once with the
 * tool set that existed before (arm "before") and once with the navigation tools added (arm "after").
 *
 *   node out-bench/e2e_ollama.js <root> <tasks.json> --model=qwen2.5-coder:3b --arm=before|after --out=x.json [--only=K3,K5]
 *
 * Runs on CPU (num_gpu=0) so it never evicts a model another workstream has loaded on the GPU.
 * Graded on source grounding: how many of the expected files the final answer cites.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolRegistry } from '../src/tools/ToolRegistry';

const [rootArg, tasksFile] = process.argv.slice(2);
const flag = (name: string, dflt = ''): string => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split('=').slice(1).join('=');
const root = path.resolve(rootArg!);
const model = flag('model', 'qwen2.5-coder:3b');
const arm = flag('arm', 'after') as 'before' | 'after';
const only = flag('only').split(',').filter(Boolean);
const maxTurns = Number(flag('turns', '8'));
const numCtx = Number(flag('ctx', '8192'));
const OLLAMA = 'http://127.0.0.1:11434';
const NAV = new Set(['find_relevant', 'find_references', 'impact_analysis', 'repo_map']);
const BASE = new Set(['read_file', 'read_file_range', 'list_directory', 'search_files', 'grep']);
const TOOL_OUTPUT_CHARS = 5_000;

interface Task { id: string; question: string; expect: string[]; expectText?: string[] }
const tasks = (JSON.parse(fs.readFileSync(tasksFile!, 'utf8')) as Task[]).filter(t => only.length === 0 || only.some(o => t.id.startsWith(o)));
const schemas = ToolRegistry.allSchemas().filter(s => BASE.has(s.function.name) || (arm === 'after' && NAV.has(s.function.name)));

const SYSTEM = `You are KarkeDikha, a read-only repository assistant. Use the tools to inspect the repository, then answer.
Base the answer only on what the tools returned. Cite each file you relied on as \`workspace/relative/path\`. Be concise.${arm === 'after'
  ? '\nPrefer find_relevant (unknown names) / find_references / impact_analysis / repo_map for questions about definitions, callers, dependents and structure; use read_file_range to confirm details.'
  : ''}`;

/** Small models often emit the call as JSON text (optionally fenced / <tool_call>-wrapped) instead of structured tool_calls. */
function inlineCalls(content: string, valid: Set<string>): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
  const out: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
  const text = content.replace(/```(?:json)?/g, '').replace(/<\/?tool_call>/g, '');
  for (let i = text.indexOf('{'); i >= 0 && i < text.length; i = text.indexOf('{', i + 1)) {
    for (let j = text.lastIndexOf('}'); j > i; j = text.lastIndexOf('}', j - 1)) {
      try {
        const obj = JSON.parse(text.slice(i, j + 1)) as { name?: string; arguments?: Record<string, unknown> };
        if (obj.name && valid.has(obj.name)) { out.push({ function: { name: obj.name, arguments: obj.arguments ?? {} } }); i = j; break; }
      } catch { /* try a shorter span */ }
    }
  }
  return out;
}
const validNames = new Set(schemas.map(s => s.function.name));

async function chat(messages: unknown[], withTools = true): Promise<{ message: { content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }; prompt_eval_count?: number; eval_count?: number }> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages, ...(withTools ? { tools: schemas } : {}), options: { num_gpu: 0, num_ctx: numCtx, temperature: 0, num_predict: 700 }, keep_alive: '2m' }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return res.json() as never;
}

(async () => {
  const rows = [];
  for (const task of tasks) {
    const messages: unknown[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: task.question }];
    const started = Date.now();
    let promptTokens = 0; let evalTokens = 0; let toolCalls = 0; let toolChars = 0; let final = ''; let turns = 0; const used: string[] = []; let firstToolMs = 0;
    const seen = new Set<string>();
    let forceFinal = false;
    for (; turns < maxTurns + 1; turns++) {
      if (turns === maxTurns) forceFinal = true; // tool budget spent
      if (forceFinal) messages.push({ role: 'user', content: 'Answer the question now from what the tools returned. Do not call any more tools. Cite the files as `path`.' });
      const reply = await chat(messages, !forceFinal);
      promptTokens += reply.prompt_eval_count ?? 0; evalTokens += reply.eval_count ?? 0;
      messages.push(reply.message);
      const calls = forceFinal ? [] : (reply.message.tool_calls && reply.message.tool_calls.length > 0) ? reply.message.tool_calls : inlineCalls(reply.message.content ?? '', validNames);
      if (calls.length === 0) { final = reply.message.content ?? ''; turns++; break; }
      for (const call of calls) {
        toolCalls++; used.push(call.function.name);
        const key = `${call.function.name}:${JSON.stringify(call.function.arguments ?? {})}`;
        if (seen.has(key)) { forceFinal = true; messages.push({ role: 'tool', content: 'Duplicate call suppressed: you already have this result.' }); continue; }
        seen.add(key);
        const tool = ToolRegistry.get(call.function.name);
        let content: string;
        const t0 = Date.now();
        try {
          const result = tool ? await tool.execute(call.function.arguments ?? {}, { workspaceRoot: root, sessionId: 's', turnId: 't', model, mode: 'ask' }) : { ok: false as const, error: `unknown tool ${call.function.name}` };
          content = result.ok ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data)) : `ERROR: ${result.error}`;
        } catch (error) { content = `ERROR: ${String(error)}`; }
        if (!firstToolMs) firstToolMs = Date.now() - t0;
        content = content.slice(0, TOOL_OUTPUT_CHARS);
        toolChars += content.length;
        messages.push({ role: 'tool', content });
      }
    }
    const cited = task.expect.filter(e => final.includes(e) || final.includes(path.basename(e))).length;
    rows.push({ id: task.id, arm, model, completed: final.trim().length > 0, turns, toolCalls, tools: used.join(','), promptTokens, evalTokens, toolChars, wallS: +((Date.now() - started) / 1000).toFixed(1), citedRecall: +(cited / task.expect.length).toFixed(2), textRecall: task.expectText?.length ? +(task.expectText.filter(e => final.includes(e)).length / task.expectText.length).toFixed(2) : 1, answer: final.replace(/\s+/g, ' ').slice(0, 260) });
    console.error(`${arm} ${task.id}: turns=${turns} tools=${used.join(',')} recall=${cited}/${task.expect.length} ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  const out = flag('out');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log(JSON.stringify(rows.map(({ answer, ...r }) => r), null, 1));
})();
