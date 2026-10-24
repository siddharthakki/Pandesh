import * as crypto from 'node:crypto';

/** M45: an approval summary is presentation plus a digest binding. Bulk
 * argument fields are projected to `{ $bytes, $sha256 }` in the bounded summary
 * while the canonical full arguments are stored apart and bound by
 * `argumentsDigest`. Policy, mission authorization and execution always read
 * the full arguments, never the projected summary text. */

export const APPROVAL_INLINE_ARGUMENT_MAX_BYTES = 512;
export const MAX_APPROVAL_ACTION_ARGUMENTS_BYTES = 3 * 1024 * 1024;
export const BULK_ARGUMENT_FIELDS = {
  propose_file_change: ['content'],
  propose_text_edit: ['find', 'replace'],
} as const;

export interface ProjectedBulkValue {
  $bytes: number;
  $sha256: string;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function isProjectedBulkValue(value: unknown): value is ProjectedBulkValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && typeof record.$bytes === 'number'
    && typeof record.$sha256 === 'string';
}

/** SHA-256 hex of the canonical JSON of the full arguments. */
export function canonicalArgumentsDigest(args: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

function bulkFieldsFor(toolName: string): readonly string[] {
  return (BULK_ARGUMENT_FIELDS as Record<string, readonly string[]>)[toolName] ?? [];
}

/** Idempotent: a string bulk field over the inline limit becomes a projected
 * value; an already-projected value passes through; every other field is
 * untouched (`path` and `command` are read by policy). */
export function projectApprovalArguments(
  toolName: string,
  args: Record<string, unknown>,
): { projected: Record<string, unknown>; projectedAny: boolean } {
  const fields = bulkFieldsFor(toolName);
  if (fields.length === 0) return { projected: args, projectedAny: false };
  let projected: Record<string, unknown> | undefined;
  for (const field of fields) {
    const value = args[field];
    if (typeof value !== 'string') continue;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= APPROVAL_INLINE_ARGUMENT_MAX_BYTES) continue;
    projected ??= { ...args };
    projected[field] = {
      $bytes: bytes,
      $sha256: crypto.createHash('sha256').update(value, 'utf8').digest('hex'),
    } satisfies ProjectedBulkValue;
  }
  return projected
    ? { projected, projectedAny: true }
    : { projected: args, projectedAny: false };
}

/** True when any bulk field already holds a projected value. */
export function hasProjectedBulkValue(toolName: string, args: Record<string, unknown>): boolean {
  return bulkFieldsFor(toolName).some((field) => isProjectedBulkValue(args[field]));
}
