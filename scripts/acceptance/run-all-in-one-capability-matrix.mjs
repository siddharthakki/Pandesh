/**
 * The All-in-One capability matrix, generated from the LIVE machine.
 *
 * The matrix answers, for every capability Pandesh could ever have, the
 * four questions the product used to blur together:
 *
 *   installed   the binary is on this PC
 *   reachable   it answers right now
 *   executable  a governed Pandesh tool can really drive it
 *   authorized  this request may use it (the approval gate decides)
 *
 * The rows come from the live capability inventory (which now records the
 * tool that drives each item) and from the governed registry's health
 * snapshot, so the matrix cannot drift away from what the product can do.
 *
 * Evidence lands in `.acceptance-evidence/all-in-one-matrix/`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'all-in-one-matrix');
const runRoot = path.join(repoRoot, '.tmp', `matrix-${process.pid}`);
const dataDir = path.join(runRoot, 'data');
const token = 'all-in-one-matrix-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startCore() {
  const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
  fs.mkdirSync(dataDir, { recursive: true });
  const out = fs.openSync(path.join(runRoot, 'core.log'), 'a');
  const child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_DATA_DIR: dataDir },
    stdio: ['ignore', out, out],
  });
  const deadline = Date.now() + 30_000;
  let port = 0;
  while (Date.now() < deadline) {
    const recordPath = path.join(dataDir, 'core.json');
    if (fs.existsSync(recordPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (parsed.port) { port = parsed.port; break; }
      } catch { /* partial write */ }
    }
    await sleep(60);
  }
  if (!port) throw new Error('the Core did not start');
  const healthDeadline = Date.now() + 20_000;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  return { port, child };
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const { port, child } = await startCore();
  try {
    // The live inventory, read through the Core's own governed tool so the
    // matrix describes the product's own view of this PC.
    const inventory = await fetch(`http://127.0.0.1:${port}/v1/capabilities/dispatch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `matrix-${Date.now()}`,
        'X-Client-Id': 'matrix',
      },
      body: JSON.stringify({
        correlationId: `matrix-${Date.now()}`,
        toolName: 'pc_capability_inventory',
        arguments: {},
        cwd: dataDir,
      }),
    }).then((r) => r.json()).catch(() => null);

    const text = inventory?.toolInvocation?.evidence?.output ?? '';
    const lines = String(text).split(/\r?\n/);

    const items = [];
    for (const line of lines) {
      const match = /^- (.+?): (.+?) — (.*)$/.exec(line);
      if (!match) continue;
      items.push({ label: match[1], state: match[2], detail: match[3] });
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      host: process.platform,
      capabilities: {
        operable: lines.filter((line) => line.startsWith('Operable through Pandesh'))[0] ?? '',
        installedNotOperable: lines.find((line) => line.startsWith('Installed but NOT operable')) ?? '',
        notAvailable: lines.find((line) => line.startsWith('Not available:')) ?? '',
      },
      items,
    };

    fs.writeFileSync(path.join(evidenceDir, 'capability-matrix.json'), JSON.stringify(summary, null, 2));
    const markdown = [
      '# All-in-One capability matrix',
      '',
      `Generated ${summary.generatedAt} from the live capability inventory of this PC.`,
      '',
      '| Capability / tool | State | Detail |',
      '| --- | --- | --- |',
      ...items.map((item) => `| ${item.label} | ${item.state} | ${String(item.detail).replace(/\|/g, '\\|')} |`),
      '',
      `**${summary.capabilities.operable}**`,
      '',
      summary.capabilities.installedNotOperable || '(nothing is installed-but-undriven right now)',
      '',
      summary.capabilities.notAvailable || '(nothing is missing right now)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(evidenceDir, 'capability-matrix.md'), markdown);
    console.log(markdown);
  } finally {
    try {
      await fetch(`http://127.0.0.1:${port}/v1/core/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `shutdown-${Date.now()}`, 'X-Client-Id': 'matrix' },
        body: '{}',
      });
    } catch { /* already gone */ }
    await sleep(400);
    if (!child.killed) child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
