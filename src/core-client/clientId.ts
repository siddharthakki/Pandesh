import * as vscode from 'vscode';
import * as crypto from 'node:crypto';

const GLOBAL_STATE_KEY = 'karkedikha.core.clientId.v1';

/** A stable per-install (per OS user, per VS Code global storage) client identity used for client_devices registration and idempotency scoping. Not a secret. */
export async function getOrCreateClientId(globalState: vscode.Memento): Promise<string> {
  const existing = globalState.get<string>(GLOBAL_STATE_KEY);
  if (existing) return existing;
  const generated = `vscode_${crypto.randomUUID()}`;
  await globalState.update(GLOBAL_STATE_KEY, generated);
  return generated;
}
