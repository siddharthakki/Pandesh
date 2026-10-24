import type { AttemptStatus, CapabilityActionRestoreEntry } from '../../../../core/shared/wireTypes';
import type { DesktopApprovalCard, DesktopApprovalResolution } from '../ipc';

const MAX_DETAIL_CHARS = 4_000;

export interface DesktopApprovalEnvelope {
  approvalId: string;
  attemptId: string;
  expectedAttemptRevision: number;
  expectedAttemptStatus: AttemptStatus;
  requestedActionDigest: string;
  frozenContextHash: string;
}

export interface DesktopCapabilityResolveInput extends DesktopApprovalEnvelope {
  resolution: DesktopApprovalResolution;
}

export function selectActionableApproval(
  actions: CapabilityActionRestoreEntry[],
): CapabilityActionRestoreEntry | null {
  return actions.find((action) => action.actionable && action.status === 'pending') ?? null;
}

export function toDesktopApprovalCard(action: CapabilityActionRestoreEntry): DesktopApprovalCard {
  return {
    approvalId: action.approvalId,
    gate: action.kind,
    toolName: action.toolName,
    scope: scopeSummary(action),
    paths: affectedPaths(action),
    detail: scopeDetail(action),
  };
}

export function toApprovalEnvelope(action: CapabilityActionRestoreEntry): DesktopApprovalEnvelope {
  return {
    approvalId: action.approvalId,
    attemptId: action.attemptId,
    expectedAttemptRevision: action.expectedAttemptRevision,
    expectedAttemptStatus: action.expectedAttemptStatus,
    requestedActionDigest: action.requestedActionDigest,
    frozenContextHash: action.frozenContextHash,
  };
}

export function toCapabilityResolveInput(
  envelope: DesktopApprovalEnvelope,
  resolution: DesktopApprovalResolution,
): DesktopCapabilityResolveInput {
  return {
    approvalId: envelope.approvalId,
    attemptId: envelope.attemptId,
    expectedAttemptRevision: envelope.expectedAttemptRevision,
    expectedAttemptStatus: envelope.expectedAttemptStatus,
    requestedActionDigest: envelope.requestedActionDigest,
    frozenContextHash: envelope.frozenContextHash,
    resolution,
  };
}

export function requireMatchingPending(
  pending: DesktopApprovalEnvelope | null,
  approvalId: string,
): DesktopApprovalEnvelope {
  if (!pending) {
    throw new Error('no pending Core approval to resolve');
  }
  if (pending.approvalId !== approvalId) {
    throw new Error('approval id does not match the pending Core gate');
  }
  return pending;
}

function scopeSummary(action: CapabilityActionRestoreEntry): string {
  if (action.toolName === 'authorize_mission') return 'Authorize autonomous mission';
  if (action.toolName === 'request_search_permission') {
    const roots = affectedPaths(action);
    return roots.length > 0
      ? `Authorize search across ${roots.join(', ')}`
      : 'Authorize file and directory search';
  }
  const paths = affectedPaths(action);
  const command = firstString(action.arguments?.command);
  if (paths.length > 0) return `${action.toolName} ${paths.join(', ')}`;
  if (command) return `${action.toolName} ${command}`;
  return `${action.kind}:${action.toolName}`;
}

function affectedPaths(action: CapabilityActionRestoreEntry): string[] {
  const presentation = action.presentation ?? {};
  const args = action.arguments ?? {};
  const rawValues = [
    presentation.path,
    args.path,
    presentation.filePath,
    args.filePath,
    presentation.proposedRoots,
    args.proposedRoots,
    presentation.searchRoots,
    args.searchRoots,
    presentation.dirPath,
    args.dirPath,
  ];
  const paths: string[] = [];
  for (const item of rawValues) {
    if (Array.isArray(item)) {
      for (const v of item) {
        if (typeof v === 'string' && v.trim() && !paths.includes(v.trim())) {
          paths.push(v.trim());
        }
      }
    } else if (typeof item === 'string' && item.trim() && !paths.includes(item.trim())) {
      paths.push(item.trim());
    }
  }
  return paths;
}

function scopeDetail(action: CapabilityActionRestoreEntry): string {
  const presentation = action.presentation ?? {};
  const cardText = firstString(presentation.cardText);
  if (cardText) return bound(cardText);
  const diff = firstString(presentation.diff);
  if (diff) return bound(diff);
  const args = action.arguments ?? {};
  const content = firstString(args.content);
  if (content) return bound(content);
  const command = firstString(args.command);
  if (command) return bound(command);
  if (action.toolName === 'gmail_create_draft') return bound(mailDraftCard(args));
  try {
    return bound(JSON.stringify(args, null, 2) ?? '');
  } catch {
    return '';
  }
}

function mailDraftCard(args: Record<string, unknown>): string {
  const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '');
  const lines = ['Save this as a draft in your Gmail (it will NOT be sent):'];
  const to = list(args.to);
  if (to) lines.push(`To: ${to}`);
  const cc = list(args.cc);
  if (cc) lines.push(`Cc: ${cc}`);
  const bcc = list(args.bcc);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${firstString(args.subject) ?? '(no subject)'}`, '', firstString(args.bodyText, args.bodyHtml) ?? '(empty body)');
  return lines.join('\n');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function bound(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n…[truncated]` : text;
}
