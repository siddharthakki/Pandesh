// Redirects require('vscode') to a CJS build of the same test-only vscode mock
// (src/test/mocks/vscode.ts) already used by vitest's alias config, so the
// compiled M15/M16 runtime modules (which transitively require('vscode') via
// src/config/Config.ts) can be exercised outside the VS Code Extension Host by
// scripts/live-m17-acceptance.mjs. Test-only; never loaded by the extension
// runtime itself.
const Module = require('module');
const path = require('path');

const stubPath = path.join(__dirname, 'm17-vscode-node-stub.cjs');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function patchedResolveFilename(request, ...rest) {
  if (request === 'vscode') {
    return stubPath;
  }
  return originalResolveFilename.call(this, request, ...rest);
};
