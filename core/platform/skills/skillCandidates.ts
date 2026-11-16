/**
 * External skill candidates: skills that exist outside the owner's own skills folder, described so the owner can decide.
 *
 * Two places feed this, both read-only:
 *  - approved local repositories: folders the owner listed in `<dataDir>/skill-repositories.json` (an array of folder
 *    paths) or put under `<dataDir>/skill-repositories/`. Only SKILL.md files are read, never run;
 *  - text the model already read from a public source (documentation, a GitHub page) with its own research tools.
 *
 * A candidate is never downloaded, installed, loaded or executed from here. The report says where it came from, how far
 * to trust it (always "unreviewed" until the owner moves it into the skills folder), its license, what it depends on,
 * whether it fits this PC, and what the directive scanner found. Using one means the owner reviews it first.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSkillMarkdown, scanSkillText, tokens, MAX_SKILL_FILE_CHARS } from './skillRuntime';
import { findSkillFiles } from './skillSources';
import { maskSecrets } from '../../shared/secretMask';

export const REPOSITORY_LIST_FILE = 'skill-repositories.json';
export const REPOSITORY_DROP_DIR = 'skill-repositories';

/** Folders the owner approved as places to look for skills. Missing or unreadable entries are skipped. */
export function approvedRepositories(dataDir: string | undefined): string[] {
  if (!dataDir) return [];
  const roots: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, REPOSITORY_LIST_FILE), 'utf8'));
    if (Array.isArray(raw)) for (const r of raw) if (typeof r === 'string' && path.isAbsolute(r)) roots.push(r);
  } catch { /* no list: fine */ }
  const drop = path.join(dataDir, REPOSITORY_DROP_DIR);
  try { if (fs.statSync(drop).isDirectory()) roots.push(drop); } catch { /* none */ }
  return [...new Set(roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } }))];
}

const LICENSE_CLASSES: Array<[RegExp, string]> = [
  [/\b(?:mit|apache[- ]?2(?:\.0)?|bsd[- ]?[23]?(?:-clause)?|isc|unlicense|cc0|0bsd)\b/i, 'permissive (reuse allowed, keep the notice)'],
  [/\b(?:agpl|gpl|lgpl|mpl|eupl|cc[- ]by[- ]sa)\b/i, 'copyleft (check the terms before reusing or copying)'],
  [/\b(?:proprietary|all rights reserved|non-?commercial|cc[- ]by[- ]nc)\b/i, 'restricted (do not copy or reuse without permission)'],
];

export function classifyLicense(text: string | undefined): string {
  const t = String(text ?? '').trim();
  if (!t) return 'none stated (treat as all rights reserved: ask before copying)';
  for (const [re, label] of LICENSE_CLASSES) if (re.test(t)) return `${t.slice(0, 40)} — ${label}`;
  return `${t.slice(0, 40)} — unrecognised, read it before reuse`;
}

function licenseOf(text: string, dir?: string): string | undefined {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const declared = fm ? /^license\s*:\s*(.+)$/im.exec(fm)?.[1]?.trim() : undefined;
  if (declared) return declared;
  if (dir) {
    for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
      try { const head = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 400); const hit = LICENSE_CLASSES.find(([re]) => re.test(head)); if (hit) return hit[0].exec(head)?.[0] ?? name; return `${name} present`; } catch { /* next */ }
    }
  }
  return undefined;
}

const DEPENDENCY_RULES: Array<[RegExp, string]> = [
  [/\b(?:pip3?|pipx|uv)\s+install\b|\bnpm\s+(?:i|install)\b|\bpnpm\s+(?:add|install)\b|\byarn\s+add\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b/i, 'installs software (Pandesh will not run these commands)'],
  [/\b(?:curl|wget|Invoke-WebRequest|iwr)\b/i, 'downloads from the internet (needs the owner\'s approval each time)'],
  [/\b(?:python3?|node|bash|sh|powershell|pwsh|cmd)\b\s+\S*\.(?:py|js|mjs|sh|ps1|bat)\b|\bscripts\//i, 'runs bundled scripts (Pandesh does not execute third-party scripts)'],
  [/\b(?:[A-Z][A-Z0-9]+_(?:API_)?(?:KEY|TOKEN|SECRET)|api[ _-]?key)\b/, 'needs an API key or token (owner adds it in Connections; never in the skill)'],
  [/\bmcp\b|\bmodelcontextprotocol\b/i, 'needs an MCP server'],
  [/\b(?:docker|kubectl|terraform|ssh)\b/i, 'needs system tools (docker/kubectl/terraform/ssh)'],
  [/\b(?:macos|brew|osascript|\.app\b|launchctl|xcode)/i, 'written for macOS'],
  [/\b(?:apt(?:-get)?|systemctl|chmod\s+\+x|\/usr\/(?:local\/)?bin)\b/i, 'written for Linux'],
];

export interface CandidateAssessment {
  name: string;
  verdict: 'review' | 'avoid';
  lines: string[];
}

/**
 * Assesses skill text (from a repository file or a page the model read). Pure: reads nothing, fetches nothing.
 * Never "safe": the best verdict is "review", meaning advice the owner may adopt after reading it.
 */
export async function assessSkillText(text: string, ctx: { origin: string; kind: 'local-repository' | 'public-web'; dir?: string }): Promise<CandidateAssessment> {
  const clipped = String(text ?? '').slice(0, MAX_SKILL_FILE_CHARS);
  const parsed = await parseSkillMarkdown(clipped, { source: 'remote', origin: ctx.origin, trust: 'untrusted' });
  const flags = scanSkillText(clipped);
  const blocks = flags.filter((f) => f.severity === 'block');
  const name = parsed.ok ? parsed.skill.name : (ctx.origin.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || 'unnamed');
  const hash = parsed.ok ? parsed.skill.provenance.hash.slice(0, 12) : 'n/a';
  const deps = DEPENDENCY_RULES.filter(([re]) => re.test(clipped)).map(([, d]) => d);
  let executables = 0;
  if (ctx.dir) {
    try { for (const e of fs.readdirSync(ctx.dir, { withFileTypes: true })) { if (e.isDirectory() && /^(?:scripts?|bin)$/i.test(e.name)) executables += 1; else if (/\.(?:py|js|mjs|sh|ps1|bat|exe|cmd)$/i.test(e.name)) executables += 1; } } catch { /* unreadable */ }
  }
  if (executables > 0) deps.push(`ships ${executables} script/executable item(s) (never run by Pandesh)`);
  const requires = parsed.ok ? parsed.skill.requires : { capabilities: [] as string[] };
  const compat: string[] = [];
  if (deps.some((d) => /macOS/.test(d))) compat.push('macOS-only steps: does not fit this Windows PC as written');
  if (deps.some((d) => /Linux/.test(d))) compat.push('Linux-only steps: needs adapting for Windows');
  if (parsed.ok && requires.capabilities.length) compat.push(`asks for permissions ${requires.capabilities.join(', ')} (a skill cannot grant them; Core decides)`);
  if (parsed.ok && (requires as { vision?: boolean }).vision) compat.push('needs a vision model');
  if (compat.length === 0) compat.push('no Windows or Pandesh conflicts found in the text (not a guarantee)');
  const source = ctx.kind === 'local-repository' ? `approved local repository: ${path.basename(path.dirname(ctx.origin))}` : `public web: ${safeUrl(ctx.origin)}`;
  const lines = [
    `Provenance: ${source}; content hash ${hash}${parsed.ok ? `; version ${parsed.skill.version}` : ''}.`,
    `Trust: UNREVIEWED external text. It is advice, not a tool or permission. Nothing is installed or run; the owner must read it before it is moved into the skills folder.`,
    `License: ${classifyLicense(licenseOf(clipped, ctx.dir))}.`,
    `Dependencies: ${deps.length ? deps.join('; ') : 'none found in the text'}.`,
    `Compatibility: ${compat.join('; ')}.`,
    blocks.length ? `Safety: BLOCKED by the directive scanner — ${blocks.map((b) => b.rule).join(', ')}. Do not use or copy it.` : flags.length ? `Safety: warnings — ${flags.map((f) => f.rule).join(', ')}.` : 'Safety: the directive scanner found nothing.',
  ];
  if (!parsed.ok) lines.push(`Format: not a valid skill file (${parsed.reason}).`);
  return { name, verdict: blocks.length || !parsed.ok ? 'avoid' : 'review', lines: lines.map((l) => maskSecrets(l).text) };
}

function safeUrl(raw: string): string {
  try { const u = new URL(raw); return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 160); } catch { return String(raw).slice(0, 100); }
}

export function formatAssessment(a: CandidateAssessment): string {
  return `- ${a.name} [${a.verdict === 'avoid' ? 'AVOID' : 'for owner review'}]\n${a.lines.map((l) => `    ${l}`).join('\n')}`;
}

/** Candidates from the approved repositories that match a task. Reads SKILL.md files only; at most `max` are returned. */
export async function searchRepositories(dataDir: string | undefined, task: string, max = 3): Promise<{ repos: number; scanned: number; found: CandidateAssessment[] }> {
  const repos = approvedRepositories(dataDir);
  const want = tokens(task);
  if (repos.length === 0 || want.length === 0) return { repos: repos.length, scanned: 0, found: [] };
  const scored: Array<{ score: number; file: string; text: string }> = [];
  let scanned = 0;
  for (const root of repos) {
    for (const file of await findSkillFiles(root)) {
      scanned += 1;
      let text: string;
      try { if (fs.statSync(file).size > MAX_SKILL_FILE_CHARS * 2) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const head = text.slice(0, 1_500);
      const have = new Set(tokens(`${path.basename(path.dirname(file))} ${head}`));
      const score = want.filter((w) => have.has(w)).length;
      if (score >= Math.min(2, want.length)) scored.push({ score, file, text });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const found: CandidateAssessment[] = [];
  for (const s of scored.slice(0, Math.max(1, Math.min(5, max)))) found.push(await assessSkillText(s.text, { origin: s.file, kind: 'local-repository', dir: path.dirname(s.file) }));
  return { repos: repos.length, scanned, found };
}
