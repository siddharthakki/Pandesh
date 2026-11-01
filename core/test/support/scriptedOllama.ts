import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted local OpenAI-compatible server that stands in for Ollama in Pi engine tests. It records the context the
 * engine assembles for every model call (system prompt, messages, offered tool names) and answers with whatever the
 * test's script returns: plain text or one tool call. Nothing leaves the machine.
 */

export interface ScriptedModelCall {
  system: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>;
  tools: string[];
}

export type ScriptedReply = { text: string } | { tool: { name: string; args: Record<string, unknown> } };

export interface ScriptedOllama {
  url: string;
  calls: ScriptedModelCall[];
  close(): Promise<void>;
}

function sse(res: http.ServerResponse, delta: Record<string, unknown>, finish: string | null) {
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

/** The text of the last user message in a call, lower-cased (what most scripts branch on). */
export function lastUserText(call: ScriptedModelCall): string {
  const user = [...call.messages].reverse().find((m) => m.role === 'user');
  return JSON.stringify(user?.content ?? '').toLowerCase();
}

/** True when the most recent message is a tool result (the model is being asked to continue after a tool ran). */
export function afterToolResult(call: ScriptedModelCall): string | null {
  const last = call.messages[call.messages.length - 1];
  if (last?.role !== 'tool') return null;
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

export async function startScriptedOllama(script: (call: ScriptedModelCall) => ScriptedReply): Promise<ScriptedOllama> {
  const calls: ScriptedModelCall[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (!req.url?.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      const payload = JSON.parse(body);
      const messages = payload.messages as ScriptedModelCall['messages'];
      const call: ScriptedModelCall = {
        system: String(messages.find((m) => m.role === 'system' || m.role === 'developer')?.content ?? ''),
        messages: messages.filter((m) => m.role !== 'system' && m.role !== 'developer'),
        tools: (payload.tools ?? []).map((t: any) => t.function.name),
      };
      calls.push(call);
      const reply = script(call);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ('tool' in reply) {
        sse(res, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${calls.length}`, type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }, null);
        sse(res, {}, 'tool_calls');
      } else {
        sse(res, { role: 'assistant', content: reply.text }, null);
        sse(res, {}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
