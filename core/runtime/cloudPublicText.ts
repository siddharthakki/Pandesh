/**
 * Central privacy gate for free cloud inference.
 *
 * Only an explicitly approved, public/general text request may leave the device, and only as
 * exactly two messages: a neutral system prompt and the operator's own text. Everything else —
 * conversation history, memory, files, attachments, workspace or repository context, tool
 * definitions, tool outputs, mail, calendar, screenshots, secrets, autonomous task context —
 * is refused before any network call. The gate never falls back to a private or local path
 * on its own; the caller decides what to do with a refusal.
 */
import { redactSecrets } from '../platform/credentialStore';

export const CLOUD_PUBLIC_TEXT_MAX_CHARS = 4000;

export const CLOUD_PUBLIC_TEXT_SYSTEM_PROMPT =
  'You are a general-purpose assistant. Answer the user\'s public, general question directly and concisely. '
  + 'You have no tools and no access to the user\'s files, email, calendar, memory or any other data, and you must not claim otherwise.';

export type CloudPublicTextRefusalCode =
  | 'approval_missing'
  | 'not_verified_free'
  | 'tools_present'
  | 'attachments_present'
  | 'workspace_context'
  | 'memory_context'
  | 'autonomous_context'
  | 'history_present'
  | 'text_empty'
  | 'text_too_long'
  | 'secret_like_text';

export interface CloudPublicTextFacts {
  /** Operator approved this exact text for cloud inference in this request. */
  approved: boolean;
  /** Zero-cost eligibility as verified by the host and the catalog rules. Only `free` passes. */
  freeness: string | undefined;
  /** Count of tool definitions that would be exposed to the model. */
  toolCount: number;
  attachmentCount: number;
  workspaceContext: boolean;
  memoryContext: boolean;
  autonomousContext: boolean;
  /** Prior conversation turns that would be sent. Public-text requests send none. */
  historyTurns: number;
  text: string;
}

export interface CloudPublicTextMessage {
  role: 'system' | 'user';
  content: string;
}

export type CloudPublicTextDecision =
  | { allowed: true; messages: [CloudPublicTextMessage, CloudPublicTextMessage] }
  | { allowed: false; code: CloudPublicTextRefusalCode; reason: string };

function refuse(code: CloudPublicTextRefusalCode, reason: string): CloudPublicTextDecision {
  return { allowed: false, code, reason: `${reason} Nothing was sent to the cloud.` };
}

/** Fail-closed decision. Checks run in a fixed order; the first refusal wins. */
export function decideCloudPublicText(facts: CloudPublicTextFacts): CloudPublicTextDecision {
  if (facts.approved !== true) return refuse('approval_missing', 'Cloud inference needs your explicit approval of this exact text.');
  if (facts.freeness !== 'free') return refuse('not_verified_free', 'The model is not verified as free of charge.');
  if (facts.toolCount > 0) return refuse('tools_present', 'Tools are never sent to a cloud model.');
  if (facts.attachmentCount > 0) return refuse('attachments_present', 'Files and images never leave the device through cloud inference.');
  if (facts.workspaceContext) return refuse('workspace_context', 'Workspace or repository context never leaves the device.');
  if (facts.memoryContext) return refuse('memory_context', 'Memory never leaves the device.');
  if (facts.autonomousContext) return refuse('autonomous_context', 'Autonomous task context never leaves the device.');
  if (facts.historyTurns > 0) return refuse('history_present', 'Conversation history never leaves the device with cloud inference.');
  const text = facts.text.trim();
  if (!text) return refuse('text_empty', 'There is no text to send.');
  if (text.length > CLOUD_PUBLIC_TEXT_MAX_CHARS) return refuse('text_too_long', `Public text is limited to ${CLOUD_PUBLIC_TEXT_MAX_CHARS} characters.`);
  if (redactSecrets(text) !== text) return refuse('secret_like_text', 'The text looks like it contains a key, token or password.');
  return {
    allowed: true,
    messages: [
      { role: 'system', content: CLOUD_PUBLIC_TEXT_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
  };
}
