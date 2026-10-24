'use strict';

const http = require('http');

/**
 * Deterministic, in-process stand-in for a real Ollama server. Speaks just
 * enough of the /api/tags and /api/chat wire protocol for the packaged-VSIX
 * acceptance harness to drive a real Forge coding task end to end without a
 * live model.
 */
function createFakeOllamaServer(modelName) {
  const requests = [];

  function stageOf(messages) {
    const joined = messages.map(m => m.content || '').join('\n');
    const match = /Stage: ([^\n]+)/.exec(joined);
    return { stage: match ? match[1] : undefined, joined };
  }

  function respond(messages) {
    const { stage, joined } = stageOf(messages);

    if (stage === 'repository-analyst' || stage === 'planner') {
      return `bounded ${stage} acceptance output`;
    }

    if (joined.includes('host-bound replace')) {
      return JSON.stringify({
        version: 1,
        taskSummary: 'Replace host-bound untracked files',
        operations: [
          {
            type: 'replace',
            path: 'src/generated/untrackedA.ts',
            reason: 'acceptance replace A',
            content: 'export const untrackedA = "after";\n',
          },
        ],
        validationCommands: [{ kind: 'tsc-no-emit' }],
        warnings: [],
        status: 'proposed',
      });
    }

    return JSON.stringify({
      version: 1,
      taskSummary: 'Create packaged acceptance file',
      operations: [
        {
          type: 'create',
          path: 'src/generated/packagedAcceptance.ts',
          reason: 'packaged VSIX acceptance harness',
          content: 'export const packagedAcceptance = true;\n',
        },
      ],
      validationCommands: [{ kind: 'tsc-no-emit' }],
      warnings: [],
      status: 'proposed',
    });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url || '';
      requests.push(url);

      if (url.startsWith('/api/tags')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: modelName, modified_at: new Date().toISOString() }] }));
        return;
      }

      if (url.startsWith('/api/chat')) {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          body = {};
        }
        const content = respond(Array.isArray(body.messages) ? body.messages : []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
  });

  return {
    requests,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    stop() {
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

module.exports = { createFakeOllamaServer };
