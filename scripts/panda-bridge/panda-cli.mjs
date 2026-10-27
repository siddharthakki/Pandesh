#!/usr/bin/env node
/**
 * Pandesh-side control of the Panda bridge, for the person at the PC. It authenticates as the Pandesh host (the host token in
 * the data directory), which is what makes it the only place an external-executor consent can be given.
 *
 *   node scripts/panda-bridge/panda-cli.mjs --data-dir <dir> pair-code
 *   node scripts/panda-bridge/panda-cli.mjs --data-dir <dir> pairings | revoke <pairingId>
 *   node scripts/panda-bridge/panda-cli.mjs --data-dir <dir> executors | tasks | task <id>
 *   node scripts/panda-bridge/panda-cli.mjs --data-dir <dir> dispatch <id> --executor opencode|claude|hermes|native|auto
 *        [--model <m>] [--allow-external] [--allow-confidential] [--include-context]
 *   node scripts/panda-bridge/panda-cli.mjs --data-dir <dir> pause|resume|cancel <id>
 *   node scripts/panda-bridge/panda-cli.mjs --data-dir <dir> approve <storyId> <pendingId> [--deny]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true; else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(String(args['data-dir'] || process.env.KARKEDIKHA_DATA_DIR || ''));
if (!args['data-dir'] && !process.env.KARKEDIKHA_DATA_DIR) { console.error('--data-dir is required'); process.exit(2); }
const port = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8')).port;
const token = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
const hostToken = fs.readFileSync(path.join(dataDir, 'host.token'), 'utf8').trim();

async function call(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Host-Token': hostToken, 'Content-Type': 'application/json', 'X-Client-Id': 'panda-cli' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) { console.error(JSON.stringify(json?.error ?? json, null, 2)); process.exit(1); }
  return json;
}

const [cmd, id, extra] = args._;
const print = (v) => console.log(JSON.stringify(v, null, 2));
switch (cmd) {
  case 'pair-code': { const r = await call('POST', '/v1/bridge/pairing-codes', {}); console.log(`Pairing code: ${r.code}  (valid until ${r.expiresAt})`); break; }
  case 'pairings': print(await call('GET', '/v1/bridge/pairings')); break;
  case 'revoke': print(await call('POST', `/v1/bridge/pairings/${id}/revoke`, {})); break;
  case 'executors': print(await call('GET', '/v1/bridge/executors')); break;
  case 'tasks': print(await call('GET', '/v1/bridge/tasks')); break;
  case 'task': print(await call('GET', `/v1/bridge/tasks/${id}`)); break;
  case 'dispatch':
    print(await call('POST', `/v1/bridge/tasks/${id}/dispatch`, {
      executor: args.executor, model: typeof args.model === 'string' ? args.model : undefined,
      consent: { externalTransfer: args['allow-external'] === true, confidentialOverride: args['allow-confidential'] === true, includeContext: args['include-context'] === true },
    }));
    break;
  case 'pause': case 'resume': case 'cancel': print(await call('POST', `/v1/bridge/tasks/${id}/${cmd}`, {})); break;
  case 'approve': print(await call('POST', `/v1/dev-stories/${id}/permissions/${extra}`, { allow: args.deny !== true, via: 'panda' })); break;
  default: console.error('commands: pair-code | pairings | revoke | executors | tasks | task | dispatch | pause | resume | cancel | approve'); process.exit(2);
}
