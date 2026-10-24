import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConnectorCredentialError,
  buildConnectorCredentialEnv,
  clearConnectorCredential,
  connectorCredentialEnvVar,
  connectorCredentialPath,
  connectorCredentialPresent,
  loadConnectorCredential,
  redactConnectorCredentialEnv,
  storeConnectorCredential,
  type SecretBox,
} from '../src/host/connectorCredentials';
import type { ConnectorId } from '../../../core/shared/wireTypes';

function memoryBox(available = true): SecretBox {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(JSON.stringify({ v: 1, p: Buffer.from(plain, 'utf8').toString('base64') }), 'utf8'),
    decryptString: (cipher) => {
      const parsed = JSON.parse(cipher.toString('utf8')) as { p?: string };
      if (typeof parsed.p !== 'string') throw new Error('undecryptable');
      return Buffer.from(parsed.p, 'base64').toString('utf8');
    },
  };
}

const CONNECTORS: ConnectorId[] = ['gmail', 'google_calendar', 'whatsapp', 'printer'];

describe('Jarvis Connector Foundation host credential store', () => {
  it('encrypts each connector credential on disk and never returns ciphertext as plaintext', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-connector-cred-'));
    for (const connectorId of CONNECTORS) {
      const secret = `${connectorId}-secret-value-not-for-logs`;
      storeConnectorCredential(dir, connectorId, secret, memoryBox());
      const onDisk = fs.readFileSync(connectorCredentialPath(dir, connectorId));
      expect(onDisk.toString('utf8')).not.toContain(secret);
      expect(loadConnectorCredential(dir, connectorId, memoryBox())).toBe(secret);
      expect(connectorCredentialPresent(dir, connectorId)).toBe(true);
      clearConnectorCredential(dir, connectorId);
      expect(loadConnectorCredential(dir, connectorId, memoryBox())).toBeNull();
      expect(connectorCredentialPresent(dir, connectorId)).toBe(false);
    }
  });

  it('keeps one credential file per connector — clearing one never touches another', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-connector-cred-isolation-'));
    storeConnectorCredential(dir, 'gmail', 'gmail-secret', memoryBox());
    storeConnectorCredential(dir, 'printer', 'printer-secret', memoryBox());
    clearConnectorCredential(dir, 'gmail');
    expect(connectorCredentialPresent(dir, 'gmail')).toBe(false);
    expect(connectorCredentialPresent(dir, 'printer')).toBe(true);
    expect(loadConnectorCredential(dir, 'printer', memoryBox())).toBe('printer-secret');
  });

  it('refuses persistence when OS-backed encryption is unavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-connector-noenc-'));
    expect(() => storeConnectorCredential(dir, 'whatsapp', 'wa-secret', memoryBox(false)))
      .toThrow(ConnectorCredentialError);
    expect(connectorCredentialPresent(dir, 'whatsapp')).toBe(false);
  });

  it('builds Core spawn-env only for connectors with a stored, decryptable credential', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-connector-env-'));
    storeConnectorCredential(dir, 'gmail', 'gmail-token-abc', memoryBox());
    const env = buildConnectorCredentialEnv(dir, memoryBox());
    expect(env[connectorCredentialEnvVar('gmail')]).toBe('gmail-token-abc');
    expect(env[connectorCredentialEnvVar('google_calendar')]).toBeUndefined();
    expect(env[connectorCredentialEnvVar('whatsapp')]).toBeUndefined();
    expect(env[connectorCredentialEnvVar('printer')]).toBeUndefined();
    expect(buildConnectorCredentialEnv(dir, null)).toEqual({});
  });

  it('redacts every connector credential env var before any env dump/log', () => {
    const secrets = CONNECTORS.map((id) => `${id}-super-secret`);
    const env: NodeJS.ProcessEnv = {};
    CONNECTORS.forEach((id, i) => { env[connectorCredentialEnvVar(id)] = secrets[i]; });
    env.PATH = '/usr/bin';
    const redacted = redactConnectorCredentialEnv(env);
    const serialized = JSON.stringify(redacted);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    for (const id of CONNECTORS) expect(redacted[connectorCredentialEnvVar(id)]).toBe('[redacted]');
    expect(redacted.PATH).toBe('/usr/bin');
  });
});
