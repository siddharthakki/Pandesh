// Pure, testable parts of the storage policy (scripts/storage-check.mjs): the exception file and the golden-evidence rules.
// Nothing here deletes anything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DAY = 24 * 3600 * 1000;
export const MAX_EXCEPTION_DAYS = 90;
export const GOLDEN_MAX_BYTES = 5 * 2 ** 30;
export const REQUIRED_FIELDS = ['owner', 'purpose', 'evidence', 'expires', 'review'];

/** Canonical comparison form of an absolute path: resolved, forward slashes, no trailing slash, lower case. */
export const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Exception line (git-excluded `.storage-approved`, one per line, '#' lines are comments):
//   path=<absolute path> | owner=<who> | purpose=<why> | evidence=<what proves the dependency> | expires=YYYY-MM-DD | review=<when to re-check>
// or   branch=<name> | ... for a local branch. Every field is required. There is no wildcard and no prefix match.
export function parseExceptionLine(line) {
  const f = {};
  for (const part of line.split('|')) {
    const i = part.indexOf('=');
    if (i < 1) return { error: `malformed field "${part.trim()}"` };
    f[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return { fields: f };
}

/** Returns { valid: Map<key, fields>, errors: string[] }. `key` is norm(path) or the branch name. */
export function loadExceptions(file, now = Date.now()) {
  const valid = new Map();
  const errors = [];
  if (!fs.existsSync(file)) return { valid, errors };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = `.storage-approved line ${idx + 1}`;
    const { fields, error } = parseExceptionLine(line);
    if (error) { errors.push(`${at}: ${error}`); return; }
    const target = fields.path ?? fields.branch;
    if (!target || (fields.path && fields.branch)) { errors.push(`${at}: needs exactly one of path= or branch=`); return; }
    const missing = REQUIRED_FIELDS.filter((k) => !fields[k]);
    if (missing.length) { errors.push(`${at}: missing ${missing.join(', ')}`); return; }
    const exp = /^\d{4}-\d{2}-\d{2}$/.test(fields.expires) ? Date.parse(`${fields.expires}T23:59:59Z`) : NaN;
    if (Number.isNaN(exp)) { errors.push(`${at}: expires must be YYYY-MM-DD`); return; }
    if (exp < now) { errors.push(`${at}: EXPIRED on ${fields.expires} (${target}) - remove the folder or renew with new evidence`); return; }
    if (exp - now > MAX_EXCEPTION_DAYS * DAY) { errors.push(`${at}: expires more than ${MAX_EXCEPTION_DAYS} days away; exceptions are temporary`); return; }
    if (fields.branch) { valid.set(`branch:${fields.branch}`, fields); return; }
    const p = fields.path;
    if (/[*?<>"|]/.test(p) || !path.isAbsolute(p)) { errors.push(`${at}: path must be an exact absolute path (no wildcards): ${p}`); return; }
    if (/[ .]$/.test(path.basename(p)) || /[ .]\\|[ .]\//.test(p)) { errors.push(`${at}: a path segment ends in a space or dot (Windows would resolve it to a sibling): ${JSON.stringify(p)}`); return; }
    const n = norm(p);
    if (n.split('/').filter(Boolean).length < 2) { errors.push(`${at}: refuses a drive root or top-level path: ${p}`); return; }
    if (!fs.existsSync(p)) { errors.push(`${at}: path no longer exists - delete this line: ${p}`); return; }
    let real;
    try { real = fs.realpathSync.native(p); } catch { errors.push(`${at}: cannot resolve ${p}`); return; }
    if (norm(real) !== n) { errors.push(`${at}: ${p} resolves to ${real} (junction, link or sibling); approve the real path instead`); return; }
    if (valid.has(n)) { errors.push(`${at}: duplicate exception for ${p}`); return; }
    valid.set(n, fields);
  });
  return { valid, errors };
}

/** Exact-match lookup only: a parent approval never covers a child or a sibling. */
export const isApproved = (valid, p) => valid.has(norm(p));
export const isBranchApproved = (valid, b) => valid.has(`branch:${b}`);

// golden-evidence: bounded by SIZE; run count is reported. Generated builds/caches are not evidence.
const GENERATED = /^(node_modules|extensions|Cache|Code Cache|GPUCache|models|runtime-assets|dist|out|out-core|electron-profile|\.vscode-test)$/i;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function walk(dir, onFile, onDir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink()) { onDir?.(f, true); continue; }
    if (e.isDirectory()) { onDir?.(f, false); walk(f, onFile, onDir); } else if (e.isFile()) onFile(f);
  }
}

/** Returns { runs, bytes, violations[] }. Never deletes. `verifyHashes` re-hashes every file a manifest lists. */
export function checkGoldenEvidence(dir, { maxBytes = GOLDEN_MAX_BYTES, verifyHashes = false } = {}) {
  const out = { runs: 0, bytes: 0, violations: [] };
  if (!fs.existsSync(dir)) return out;
  out.runs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  const generated = [];
  const links = [];
  walk(dir, (f) => { try { out.bytes += fs.statSync(f).size; } catch { /* vanished */ } }, (d, isLink) => {
    if (isLink) links.push(d); else if (GENERATED.test(path.basename(d))) generated.push(d);
  });
  if (out.bytes > maxBytes) out.violations.push(`golden-evidence is ${(out.bytes / 2 ** 30).toFixed(1)} GB (limit ${(maxBytes / 2 ** 30).toFixed(0)} GB, ${out.runs} run folders): archive or drop the oldest runs after review; nothing is deleted automatically`);
  for (const g of generated.slice(0, 10)) out.violations.push(`golden-evidence holds a generated build or cache, not evidence: ${g}`);
  if (generated.length > 10) out.violations.push(`... and ${generated.length - 10} more generated folders in golden-evidence`);
  for (const l of links.slice(0, 5)) out.violations.push(`golden-evidence contains a junction or link (could escape the folder): ${l}`);
  // Evidence that was relocated by a trim must be listed in a manifest, and every manifest entry must still exist.
  const manifests = fs.readdirSync(dir).filter((n) => /^TRIM-MANIFEST-.*\.json$/i.test(n));
  const listed = new Set();
  for (const m of manifests) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, m), 'utf8')); } catch { out.violations.push(`golden-evidence manifest is unreadable: ${m}`); continue; }
    for (const mv of j.moved ?? []) {
      listed.add(norm(mv.to));
      if (!fs.existsSync(mv.to)) { out.violations.push(`manifest ${m} lists evidence that is missing: ${mv.to}`); continue; }
      let n = 0;
      walk(mv.to, () => { n += 1; });
      if (n !== mv.files) out.violations.push(`manifest ${m}: ${mv.to} has ${n} files, expected ${mv.files}`);
      else if (verifyHashes) for (const [rel, h] of Object.entries(mv.hashes ?? {})) { const f = path.join(mv.to, rel); if (!fs.existsSync(f) || sha(f) !== h) out.violations.push(`manifest ${m}: hash mismatch or missing file ${f}`); }
    }
  }
  const retained = [];
  for (const run of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const r = path.join(dir, run.name, 'retained-from-extension');
    if (!fs.existsSync(r)) continue;
    for (const ext of fs.readdirSync(r, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const k of fs.readdirSync(path.join(r, ext.name), { withFileTypes: true }).filter((d) => d.isDirectory())) retained.push(path.join(r, ext.name, k.name));
    }
  }
  for (const r of retained) if (!listed.has(norm(r))) out.violations.push(`retained evidence without a manifest entry: ${r}`);
  return out;
}
