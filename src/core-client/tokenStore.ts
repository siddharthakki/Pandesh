import * as vscode from 'vscode';
import * as crypto from 'node:crypto';

const SECRET_KEY = 'karkedikha.core.token.v1';

/**
 * The Core auth token lives only in VS Code SecretStorage under a fixed key
 * name, scoped to the OS user account (see M31 §5 same-profile boundary).
 * Every window/profile for the same OS user resolves to the same token and
 * therefore the same singleton Core. Never logged, never placed in argv,
 * never written to the discovery record or any database row.
 */
export async function getOrCreateCoreToken(secrets: vscode.SecretStorage): Promise<string> {
  const existing = await secrets.get(SECRET_KEY);
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString('base64url');
  await secrets.store(SECRET_KEY, generated);
  return generated;
}

export async function clearCoreToken(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(SECRET_KEY);
}
