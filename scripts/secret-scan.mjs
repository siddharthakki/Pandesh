#!/usr/bin/env node
/**
 * Secret scan for Pandesh. Never prints a secret value: findings name the commit (or "staged"), file, line and rule.
 *
 *   node scripts/secret-scan.mjs --staged    pre-commit: added lines in the staged diff (exit 1 on a finding)
 *   node scripts/secret-scan.mjs --history   every commit on every ref (report only; exit 1 on a finding)
 *
 * Also runs gitleaks (with --redact) when it is installed, and reports only its counts and locations.
 * A finding in history means: rotate that key at its provider. History is never rewritten by this script.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const RULES = [
  ['openrouter-key', /\bsk-or-v1-[a-f0-9]{32,}\b/],
  ['openai-style-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['groq-key', /\bgsk_[A-Za-z0-9]{40,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['nvidia-key', /\bnvapi-[A-Za-z0-9_-]{40,}\b/],
  ['cerebras-key', /\bcsk-[a-z0-9]{40,}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['google-oauth-secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['env-assignment', /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*['"]?[A-Za-z0-9_\-./+=]{16,}/],
];
/** Obvious placeholders and the repo's own dummy test values are not secrets. */
const ALLOW = /DUMMY|EXAMPLE|PLACEHOLDER|REDACTED|your[-_]?key|xxxxxxxx|0000000000|fake|sample|<[^>]+>|\$\{|process\.env/i;
const SKIP_FILE = /(^|\/)(package-lock\.json|.*\.min\.js|.*\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|zip|exe|bin|onnx|gguf))$/i;

function scanLines(lines, where, findings) {
  let file = '';
  let line = 0;
  for (const raw of lines) {
    if (raw.startsWith('+++ ')) { file = raw.slice(6); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]) - 1; continue; }
    if (raw.startsWith('commit ')) { where.commit = raw.slice(7, 19); continue; }
    if (!raw.startsWith('+') || raw.startsWith('+++')) { if (!raw.startsWith('-')) line += 1; continue; }
    line += 1;
    if (!file || SKIP_FILE.test(file)) continue;
    const text = raw.slice(1);
    for (const [rule, re] of RULES) {
      const m = re.exec(text);
      if (m && !ALLOW.test(m[0]) && !ALLOW.test(text)) findings.push({ commit: where.commit ?? 'staged', file, line, rule });
    }
  }
}

function gitleaks(mode) {
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (probe.status !== 0) return { available: false };
  const report = path.join(os.tmpdir(), `pandesh-gitleaks-${process.pid}.json`);
  const args = mode === 'staged'
    ? ['git', '--staged', '--redact', '--no-banner', '--report-format', 'json', '--report-path', report, '.']
    : ['git', '--redact', '--no-banner', '--log-opts=--all', '--report-format', 'json', '--report-path', report, '.'];
  spawnSync('gitleaks', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let leaks = [];
  try { leaks = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { /* no report = no leaks */ }
  try { fs.unlinkSync(report); } catch { /* none */ }
  return { available: true, findings: leaks.map((l) => ({ commit: (l.Commit ?? 'staged').slice(0, 12), file: l.File, line: l.StartLine, rule: `gitleaks:${l.RuleID}` })) };
}

const mode = process.argv.includes('--history') ? 'history' : 'staged';
const diff = mode === 'staged'
  ? execFileSync('git', ['diff', '--cached', '-U0', '--no-color'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  : execFileSync('git', ['log', '--all', '-p', '-U0', '--no-color', '--format=commit %H'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 * 1024 });
const findings = [];
scanLines(diff.split(/\r?\n/), {}, findings);
const gl = gitleaks(mode);
const all = [...findings, ...(gl.findings ?? [])];
const unique = [...new Map(all.map((f) => [`${f.commit}|${f.file}|${f.line}|${f.rule}`, f])).values()];
console.log(`secret scan (${mode}): ${findings.length} built-in finding(s); gitleaks ${gl.available ? `${gl.findings.length} finding(s) (redacted)` : 'not installed'}`);
for (const f of unique.slice(0, 200)) console.log(`  ${f.commit}  ${f.file}:${f.line}  [${f.rule}]`);
if (unique.length) {
  console.log(mode === 'staged'
    ? 'Commit blocked: remove the secret (keys belong in Windows Credential Manager via Pandesh settings), or replace it with a placeholder.'
    : 'Rotate any real key listed above at its provider. History has NOT been rewritten.');
  process.exit(1);
}
