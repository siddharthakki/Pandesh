/**
 * Gaps 1, 4 and 5 of the production pass (2026-11-09), all judged by Core rather than by the model:
 *
 *  - unfinishedRequestedSteps: the request asked to open / verify the result, or the reply hands a fix back to the
 *    user although the model can write files — the turn is not finished (F13g).
 *  - suggestedCommandProblems: a command the reply tells the user to run that cannot work as written
 *    (T14: "python -m board.cli" where board.py is a module, not a package).
 *  - thirdPartyImportProblems: a written Python file imports a package that does not load on this PC
 *    (T14: Flask was broken against the installed jinja2 and nobody noticed).
 *
 * Pure except for the injected runner, which only imports already-installed packages (never the generated code).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SyncRunner } from './outputChecks';

const WANTS_OPEN = /\bopen\s+(?:it|them|this|that|the\s+(?:file|report|page|dashboard|result|html)|[^.?!]{0,40}\bin\s+(?:my|the)\s+browser)\b|\bshow\s+(?:it|me\s+the\s+(?:page|dashboard|report))\b/i;
const WANTS_VERIFY = /\b(?:verify|validate|check\s+(?:that\s+)?it\s+works|make\s+sure\s+it\s+works|test\s+it)\b/i;
const HANDS_BACK_FIX = /\b(?:you\s+(?:should|need\s+to|can|could|may\s+want\s+to|will\s+need\s+to)\s+(?:correct|fix|change|update|edit|replace|adjust)|please\s+(?:correct|fix|change|update|edit|adjust))\b/i;
const PRODUCED = /^(?:write_file|propose_file_change|propose_text_edit|delegate_to_opencode|delegate_to_agent|delegate_to_coding_agent)$/;

export function unfinishedRequestedSteps(request: string, reply: string, succeededTools: readonly string[], canWrite: boolean): string[] {
  const produced = succeededTools.some((t) => PRODUCED.test(t));
  const steps: string[] = [];
  if (produced && WANTS_OPEN.test(request) && !succeededTools.includes('open_local_file')) {
    steps.push("the user asked you to open the result, and nothing was opened: call open_local_file with the file you wrote");
  }
  if (produced && WANTS_VERIFY.test(request) && !succeededTools.some((t) => /^(?:read_file|run_checks|inspect_page)$/.test(t))) {
    steps.push('the user asked you to verify the result, and nothing checked it: read the file back with read_file (or run a real check) and compare it with the source data');
  }
  if (canWrite && HANDS_BACK_FIX.test(reply)) {
    steps.push('your reply tells the user to fix something you can fix yourself: make that correction now with write_file');
  }
  return steps;
}

/** Commands the reply presents for the user to run (inline code or code-block lines). */
export function suggestedCommands(reply: string): string[] {
  const out = new Set<string>();
  for (const m of reply.matchAll(/`([^`\n]{3,200})`/g)) out.add(m[1].trim());
  for (const block of reply.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const line of block[1].split('\n')) out.add(line.trim());
  return [...out].filter((c) => /^(?:python3?|py|node|npm\s+run|npm\s+start)\b/i.test(c));
}

/** Problems with commands that can be decided statically against the workspace (nothing is run). */
export function suggestedCommandProblems(reply: string, workspaceRoot: string): string[] {
  const problems: string[] = [];
  for (const cmd of suggestedCommands(reply).slice(0, 8)) {
    if (/&&|\bcd\b|[|;]/.test(cmd)) continue; // a working directory change makes the check unreliable
    const moduleRun = /^(?:python3?|py)\s+-m\s+([A-Za-z_][\w.]*)/i.exec(cmd);
    if (moduleRun) {
      // rwRun2 G4: `python -m unittest test_tracker.py` on pytest-style functions runs 0 tests ("NO TESTS RAN").
      if (moduleRun[1] === 'unittest') {
        for (const target of cmd.slice(moduleRun[0].length).trim().split(/\s+/).filter((a) => a && !a.startsWith('-') && a !== 'discover')) {
          const file = path.join(workspaceRoot, /\.py$/i.test(target) ? target : `${target.replace(/\./g, path.sep)}.py`);
          let text = '';
          try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
          if (!/\bTestCase\b/.test(text)) problems.push(`\`${cmd}\` runs 0 tests: ${path.basename(file)} has no unittest.TestCase class${/^def test_/m.test(text) && /__main__/.test(text) ? ` (its test functions are pytest-style and its own main block runs them: \`python ${path.basename(file)}\`)` : ''}`);
        }
        continue;
      }
      const parts = moduleRun[1].split('.');
      if (parts.length > 1) {
        const pkgDir = path.join(workspaceRoot, parts[0]);
        const asModule = path.join(workspaceRoot, `${parts[0]}.py`);
        if (!fs.existsSync(pkgDir) && fs.existsSync(asModule)) problems.push(`\`${cmd}\` will not work: ${parts[0]}.py is a module, not a package, so ${moduleRun[1]} cannot be found`);
        else if (fs.existsSync(pkgDir) && !fs.existsSync(path.join(pkgDir, ...parts.slice(1)) + '.py') && !fs.existsSync(path.join(pkgDir, ...parts.slice(1)))) problems.push(`\`${cmd}\` will not work: ${parts.slice(1).join('/')} does not exist in ${parts[0]}/`);
      }
      continue;
    }
    const scriptRun = /^(?:python3?|py|node)\s+(?!-)([^\s]+\.(?:py|js|mjs|cjs))\b/i.exec(cmd);
    if (scriptRun) {
      const file = scriptRun[1].replace(/^["']|["']$/g, '');
      const full = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
      if (!fs.existsSync(full)) problems.push(`\`${cmd}\` will not work: ${file} does not exist in the folder`);
      continue;
    }
    const npmRun = /^npm\s+run\s+([\w:-]+)/i.exec(cmd);
    if (npmRun) {
      const pkgPath = path.join(workspaceRoot, 'package.json');
      try {
        const scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
        if (!scripts[npmRun[1]]) problems.push(`\`${cmd}\` will not work: package.json has no "${npmRun[1]}" script`);
      } catch { problems.push(`\`${cmd}\` will not work: there is no readable package.json in the folder`); }
    }
  }
  return problems;
}

const IMPORT_LINE = /^\s*(?:from\s+([A-Za-z_]\w*)[\w.]*\s+import\b|import\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*))/gm;

/** Top-level modules a Python file imports that are neither local files nor relative imports. */
export function importedTopModules(content: string, dir: string): string[] {
  const names = new Set<string>();
  for (const m of content.matchAll(IMPORT_LINE)) {
    const list = m[1] ? [m[1]] : m[2].split(',').map((s) => s.trim().split(/\s+/)[0]);
    for (const n of list) if (n && n !== '__future__') names.add(n);
  }
  return [...names].filter((n) => !fs.existsSync(path.join(dir, `${n}.py`)) && !fs.existsSync(path.join(dir, n)));
}

const IMPORT_PROBE = 'import sys, importlib\nfor m in sys.argv[1:]:\n    if m in getattr(sys, "stdlib_module_names", ()):\n        continue\n    try:\n        importlib.import_module(m)\n    except Exception as e:\n        print(f"{m}: {type(e).__name__}: {str(e)[:160]}")';

/** Installed packages the file needs that fail to import on this PC (stdlib and local modules are skipped). */
export function thirdPartyImportProblems(file: string, content: string, run: SyncRunner): string[] {
  if (!/\.py$/i.test(file)) return [];
  const modules = importedTopModules(content, path.dirname(file)).slice(0, 20);
  if (!modules.length) return [];
  const r = run('python', ['-c', IMPORT_PROBE, ...modules]);
  if (r.error) return [];
  return String(r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => `${l} — this program cannot run on this PC until that is fixed`);
}

/** Technology names that look like file names ("Node.js") and are never an output. */
const TECH_NAMES = /^(?:node|vue|react|next|nuxt|three|d3|chart|express|socket\.io|angular|ember|backbone|deno|bun)\.js$/i;
const PRODUCE_VERB = /\b(?:create|write|save|build|generate|make|produce|export|output)\b/i;

/**
 * Files a hand-off brief asks the agent to PRODUCE (rwRun2 T07: "Node.js" in a research brief was taken for an output
 * file and a correct research hand-off was reported NOT DONE). A name counts only in a sentence that asks to create,
 * write or save something, and never a technology name.
 */
export function expectedOutputFiles(brief: string): string[] {
  const out = new Set<string>();
  for (const sentence of String(brief ?? '').split(/(?<=[.!?])\s+|\n+/)) {
    if (!PRODUCE_VERB.test(sentence)) continue;
    for (const m of sentence.matchAll(/(?<![\w.])[\w-]+\.(?:html?|py|js|ts|md|csv|json|txt)\b/gi)) {
      if (!TECH_NAMES.test(m[0])) out.add(m[0]);
    }
  }
  return [...out];
}

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const CALENDAR_DATE = new RegExp(`\\b(?:${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{2,4})\\b`, 'gi');
const dateKey = (d: string) => d.toLowerCase().replace(/(?:st|nd|rd|th)\b/g, '').replace(/\bof\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * rwRun2 T09: told "Monday", the model stored "Monday, Nov 9" (and later "Thursday, Nov 12"). A calendar date in a
 * memory value must come from what the user said; returns the dates that did not.
 */
export function inventedDates(value: string, userText: string): string[] {
  const given = new Set([...String(userText ?? '').matchAll(CALENDAR_DATE)].map((m) => dateKey(m[0])));
  return [...String(value ?? '').matchAll(CALENDAR_DATE)].map((m) => m[0]).filter((d) => !given.has(dateKey(d)));
}
