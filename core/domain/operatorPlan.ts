/**
 * Master-operator planning and tool selection (pure: no I/O, no clock).
 *
 * One natural-language instruction becomes a workflow, a privacy class and an ordered plan of steps. Each step names the
 * capability it needs; the selector then picks a concrete tool from the *live* catalog (core/runtime/toolCatalog.ts), or
 * says exactly why it cannot.
 *
 * The privacy rules live here and nowhere else:
 * - A `local_only` run (personal files, mail, finance, JUGAAD, anything that looks confidential) can only ever use local
 *   tools. There is no consent that lets it fall through to an external one, and no silent substitution.
 * - A `public` run prefers local tools and may use an external one only with explicit consent recorded on the run.
 * - A tool or model the user named is binding: if it cannot run, the step is blocked, never swapped for another.
 */
import { classifySensitivity } from './pandaBridge';

export type WorkflowKind = 'public_research' | 'local_files' | 'coding' | 'unsupported';
export type PrivacyClass = 'local_only' | 'public';

export type CapabilityNeed = 'web_research' | 'local_filesystem' | 'pdf_reader' | 'local_model' | 'coding_executor';

export interface CatalogEntry {
  /** Stable id: `ollama:<model>`, `executor:opencode`, `capability:web_research`. */
  id: string;
  kind: 'model' | 'executor' | 'capability';
  label: string;
  provides: CapabilityNeed[];
  /** Whether using it sends the task or its data off this PC. */
  locality: 'local' | 'external';
  available: boolean;
  /** Why it is unavailable (or a caveat when available). */
  reason: string | null;
  /** Lower is preferred among equals. */
  preference: number;
}

export interface ToolCatalog {
  probedAt: string;
  entries: CatalogEntry[];
}

export interface RunConsent {
  /** The user approved sending the (sanitized) task to an external tool for this run. */
  externalTransfer?: boolean;
  /** The user approved sending the exact, sanitized search queries shown to them to the web. Separate from `externalTransfer`. */
  webEgress?: boolean;
}

export type StepKind =
  | 'approve_egress' | 'search' | 'synthesize' | 'verify_research'
  | 'discover_files' | 'read_documents' | 'propose_organization' | 'verify_proposal' | 'approve_move' | 'apply_move' | 'verify_move'
  | 'select_executor' | 'run_executor' | 'verify_deliverable';

export interface PlannedStep {
  kind: StepKind;
  title: string;
  /** The capability to select a tool for; absent for approvals and pure verification. */
  needs: CapabilityNeed | null;
  /** Steps that mutate or send data and therefore stop for an explicit human decision. */
  approval: 'egress' | 'file_move' | null;
  maxAttempts: number;
}

export interface WorkflowPlan {
  workflow: WorkflowKind;
  privacy: PrivacyClass;
  privacyReasons: string[];
  steps: PlannedStep[];
}

// ------------------------------------------------------------------ classification

const PERSONAL_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:my|our)\s+(?:downloads?|documents?|desktop|pictures|files?|folders?|inbox|emails?|mails?|gmail|calendar|invoices?|bank|taxes|tax|finances?|payslips?|contracts?)\b/i, 'refers to your own files or accounts'],
  [/\b(?:downloads?|documents?|desktop)\s+(?:folder|directory)\b/i, 'names a personal folder'],
  [/\bgmail|google\s+drive|e-?mails?\b/i, 'involves mail or cloud documents'],
  [/\binvoices?|receipts?|bank\s+statements?|payslips?|tax\s+returns?|passport|salary|rechnung\w*\b/i, 'involves financial or identity documents'],
  [/\bjugaad\b/i, 'involves JUGAAD'],
  [/\b[A-Za-z]:\\(?:Users|Documents)\b/i, 'names a local path'],
];

export function classifyWorkflow(instruction: string): WorkflowKind {
  const t = instruction.replace(/\s+/g, ' ').trim();
  const filesSubject = /\b(?:pdfs?|invoices?|receipts?|documents?|files?|folders?)\b/i.test(t);
  const filesAction = /\b(?:find|list|show|organi[sz]e|sort|look\s+(?:for|through)|scan|search\s+(?:my|for))\b/i.test(t);
  const personalLocation = /\b(?:downloads?|documents|desktop)\b|[A-Za-z]:\\/i.test(t);
  if (filesSubject && filesAction && personalLocation) return 'local_files';
  const buildVerb = /\b(?:build|create|make|develop|implement|code|write)\b/i.test(t);
  const artefact = /\b(?:web\s?site|web\s?page|landing\s+page|web\s?app|app|application|page|tool|game|calculator|api|script|cli)\b/i.test(t);
  if (buildVerb && artefact) return 'coding';
  if (/\b(?:research|investigate|look\s+up|find\s+out|latest|today'?s|news|developments?|what'?s\s+new|state\s+of)\b/i.test(t)) return 'public_research';
  return 'unsupported';
}

export function classifyPrivacy(instruction: string, workflow: WorkflowKind, userMarkedConfidential = false): { privacy: PrivacyClass; reasons: string[] } {
  const reasons: string[] = [];
  if (workflow === 'local_files') reasons.push('works on files on this PC');
  for (const [re, why] of PERSONAL_MARKERS) if (re.test(instruction)) reasons.push(why);
  const sensitive = classifySensitivity(instruction, userMarkedConfidential);
  reasons.push(...sensitive.reasons);
  const unique = [...new Set(reasons)];
  return { privacy: unique.length ? 'local_only' : 'public', reasons: unique };
}

// ------------------------------------------------------------------ plans

const step = (kind: StepKind, title: string, needs: CapabilityNeed | null, maxAttempts = 1, approval: PlannedStep['approval'] = null): PlannedStep =>
  ({ kind, title, needs, maxAttempts, approval });

export function planWorkflow(instruction: string, opts: { userMarkedConfidential?: boolean } = {}): WorkflowPlan {
  const workflow = classifyWorkflow(instruction);
  const { privacy, reasons } = classifyPrivacy(instruction, workflow, opts.userMarkedConfidential);
  let steps: PlannedStep[];
  switch (workflow) {
    case 'public_research':
      steps = [
        step('approve_egress', 'Approve sending the search queries to the web', null, 1, 'egress'),
        step('search', 'Search the web and fetch sources', 'web_research', 2),
        step('synthesize', 'Synthesize locally and recommend', 'local_model', 2),
        step('verify_research', 'Verify citations against fetched sources', null),
      ];
      break;
    case 'local_files':
      steps = [
        step('discover_files', 'Find PDF files locally (read-only)', 'local_filesystem'),
        step('read_documents', 'Read the PDFs locally', 'pdf_reader'),
        step('propose_organization', 'Propose how to organize the invoices', null),
        step('verify_proposal', 'Verify nothing changed and the proposal is consistent', null),
        step('approve_move', 'Ask before moving any file', null, 1, 'file_move'),
        step('apply_move', 'Move the approved files', 'local_filesystem'),
        step('verify_move', 'Verify every file arrived and nothing was lost', null),
      ];
      break;
    case 'coding':
      steps = [
        step('select_executor', 'Choose an available coding executor', 'coding_executor', 2),
        step('run_executor', 'Build in an isolated workspace', 'coding_executor', 2),
        step('verify_deliverable', 'Verify the build and tests independently', null),
      ];
      break;
    default:
      steps = [];
  }
  return { workflow, privacy, privacyReasons: reasons, steps };
}

// ------------------------------------------------------------------ selection

export type SelectionFailure =
  | 'none_available' | 'pinned_unavailable' | 'pinned_privacy_violation' | 'privacy_blocked' | 'external_consent_required';

export interface Considered { id: string; label: string; verdict: 'selected' | 'available' | 'rejected'; why: string }

export type Selection =
  | { ok: true; entry: CatalogEntry; considered: Considered[] }
  | { ok: false; code: SelectionFailure; message: string; considered: Considered[] };

export interface SelectionContext {
  privacy: PrivacyClass;
  consent?: RunConsent;
  /** An entry id or a bare name the user chose (`opencode`, `gemma4:12b`). Binding. */
  pinned?: string | null;
}

function matchesPin(entry: CatalogEntry, pin: string): boolean {
  const p = pin.toLowerCase();
  return entry.id.toLowerCase() === p || entry.id.toLowerCase().endsWith(`:${p}`) || entry.label.toLowerCase() === p;
}

/**
 * Picks a tool for one need. The order of the checks is the policy: privacy is decided before availability or preference,
 * so a private run never even considers an external tool as a fallback.
 */
export function selectTool(need: CapabilityNeed, catalog: ToolCatalog, ctx: SelectionContext): Selection {
  const candidates = catalog.entries.filter(e => e.provides.includes(need)).sort((a, b) => a.preference - b.preference || a.id.localeCompare(b.id));
  const considered: Considered[] = [];
  const consented = ctx.consent?.externalTransfer === true;

  const pin = ctx.pinned?.trim();
  if (pin) {
    const entry = candidates.find(e => matchesPin(e, pin));
    if (!entry) {
      return { ok: false, code: 'pinned_unavailable', message: `You chose '${pin}', but it is not a known ${need.replace('_', ' ')} tool on this PC. Nothing else was substituted.`, considered };
    }
    if (entry.locality === 'external' && ctx.privacy === 'local_only') {
      considered.push({ id: entry.id, label: entry.label, verdict: 'rejected', why: 'external tool for a private task' });
      return { ok: false, code: 'pinned_privacy_violation', message: `You chose ${entry.label}, which sends data off this PC, but this task is private (${need}). Nothing was sent. Choose a local tool.`, considered };
    }
    if (entry.locality === 'external' && !consented) {
      considered.push({ id: entry.id, label: entry.label, verdict: 'rejected', why: 'external; no consent' });
      return { ok: false, code: 'external_consent_required', message: `${entry.label} sends this task to an external service. Nothing was sent. Approve the transfer for this run, or choose a local tool.`, considered };
    }
    if (!entry.available) {
      considered.push({ id: entry.id, label: entry.label, verdict: 'rejected', why: entry.reason ?? 'unavailable' });
      return { ok: false, code: 'pinned_unavailable', message: `You chose ${entry.label}, but it is not available: ${entry.reason ?? 'unavailable'}. Nothing else was substituted.`, considered };
    }
    considered.push({ id: entry.id, label: entry.label, verdict: 'selected', why: 'chosen by you' });
    return { ok: true, entry, considered };
  }

  let chosen: CatalogEntry | null = null;
  let blockedByPrivacy = false;
  let blockedByConsent: CatalogEntry | null = null;
  for (const entry of candidates) {
    if (entry.locality === 'external' && ctx.privacy === 'local_only') {
      considered.push({ id: entry.id, label: entry.label, verdict: 'rejected', why: 'external; this task is private' });
      blockedByPrivacy = true;
      continue;
    }
    if (!entry.available) {
      considered.push({ id: entry.id, label: entry.label, verdict: 'rejected', why: entry.reason ?? 'unavailable' });
      continue;
    }
    if (entry.locality === 'external' && !consented) {
      considered.push({ id: entry.id, label: entry.label, verdict: 'rejected', why: 'external; needs your consent' });
      blockedByConsent ??= entry;
      continue;
    }
    if (!chosen) {
      chosen = entry;
      considered.push({ id: entry.id, label: entry.label, verdict: 'selected', why: entry.locality === 'local' ? 'available, runs on this PC' : 'available, you consented to external use' });
    } else {
      considered.push({ id: entry.id, label: entry.label, verdict: 'available', why: 'also available' });
    }
  }
  if (chosen) return { ok: true, entry: chosen, considered };
  if (blockedByConsent) {
    return { ok: false, code: 'external_consent_required', message: `The only available ${need.replace('_', ' ')} tool is ${blockedByConsent.label}, which sends this task off your PC. Nothing was sent. Approve the transfer for this run, or install a local tool.`, considered };
  }
  if (blockedByPrivacy) {
    return { ok: false, code: 'privacy_blocked', message: `No local ${need.replace('_', ' ')} tool is available, and this task is private (${need}), so no external tool was tried.`, considered };
  }
  return { ok: false, code: 'none_available', message: `No ${need.replace('_', ' ')} tool is available on this PC.`, considered };
}

// ------------------------------------------------------------------ outbound sanitization

/**
 * What may leave the PC as a web query. Conservative and model-free: paths, e-mail addresses, long digit runs and anything
 * `classifySensitivity` flags are removed or refuse the query outright. The sanitized text is what the user is shown and
 * approves, so consent is for the exact bytes sent.
 */
export function sanitizeOutboundQuery(query: string): { ok: true; query: string } | { ok: false; reason: string } {
  const cleaned = query
    .replace(/[A-Za-z]:\\[^\s"']*/g, ' ')
    .replace(/\\\\[^\s"']+/g, ' ')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, ' ')
    .replace(/\bhttps?:\/\/\S*/gi, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (cleaned.length < 3) return { ok: false, reason: 'nothing left to search for after removing private details' };
  const s = classifySensitivity(cleaned);
  if (s.sensitivity === 'confidential') return { ok: false, reason: `the query looks confidential (${s.reasons.join(', ')})` };
  return { ok: true, query: cleaned };
}
