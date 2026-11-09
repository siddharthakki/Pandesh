/**
 * A rehearsal copy of a profile must carry the data but not the live identity or the secrets of the original:
 * no core.json/core.token (the Build 160 incident), no ownership ledger, no credentials and no key to decrypt them,
 * no phone pairing — and its schedules must not fire a second time next to production.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// @ts-expect-error — plain ES module script (no type declarations)
import { cloneProfileForRehearsal } from '../scripts/clone-profile-for-rehearsal.mjs';

const dirs: string[] = [];
const makeDir = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function syntheticProfile(): string {
  const dir = makeDir('pandesh-clone-src-');
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  for (const name of ['core.json', 'core.lock', 'core.token', 'host.token', 'client-id.json', 'port-manager.token', 'port-manager-registry.json', 'process-ownership-ledger.json', 'browser-launched-processes.json', 'mobile-pair.json', 'companion-tls.json', 'companion-vault.json', 'companion-sync.json']) {
    write(name, '{"synthetic":true}');
  }
  write('connector.gmail.credential.bin', 'ciphertext');
  write('cloud-provider-openrouter.credential.bin', 'ciphertext');
  write('electron-profile/Local State', '{"os_crypt":{"encrypted_key":"synthetic"}}');
  write('logs/core.log', 'log line');
  write('workspace-activity/activities.json', '[]');
  write('host-preferences.json', '{"uiVariant":"v2"}');
  write('timers.json', '[]');
  const db = new DatabaseSync(path.join(dir, 'core.db'));
  db.exec(`CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, title TEXT, enabled INTEGER);
           INSERT INTO scheduled_tasks VALUES ('s1','Daily brief',1),('s2','AI Radar',1),('s3','old test',0);
           CREATE TABLE core_metadata (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT);
           INSERT INTO core_metadata VALUES ('singleton_owner','{"instanceId":"live","pid":1}','now'),('other','1','now');
           CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT);
           INSERT INTO conversations VALUES ('c1','kept');`);
  db.close();
  return dir;
}

describe('clone-profile-for-rehearsal', () => {
  it('copies the data, leaves out live identity and secrets, and disables schedules in the copy only', () => {
    const source = syntheticProfile();
    const target = path.join(makeDir('pandesh-clone-dst-'), 'copy');
    const summary = cloneProfileForRehearsal({ from: source, to: target });

    for (const name of ['core.json', 'core.lock', 'core.token', 'host.token', 'client-id.json', 'port-manager.token', 'port-manager-registry.json', 'process-ownership-ledger.json', 'browser-launched-processes.json', 'mobile-pair.json', 'companion-tls.json', 'companion-vault.json', 'companion-sync.json', 'connector.gmail.credential.bin', 'cloud-provider-openrouter.credential.bin', 'electron-profile', 'logs']) {
      expect(fs.existsSync(path.join(target, name)), name).toBe(false);
    }
    expect(fs.readFileSync(path.join(target, 'host-preferences.json'), 'utf8')).toContain('v2');
    expect(fs.existsSync(path.join(target, 'workspace-activity', 'activities.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'rehearsal-clone.json'))).toBe(true);

    const copy = new DatabaseSync(path.join(target, 'core.db'), { readOnly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM scheduled_tasks WHERE enabled = 1').get()).toEqual({ n: 0 });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM core_metadata WHERE key = 'singleton_owner'").get()).toEqual({ n: 0 });
    expect(copy.prepare("SELECT title FROM conversations WHERE id = 'c1'").get()).toEqual({ title: 'kept' });
    copy.close();
    expect(summary.schedulesDisabled).toBe(2);
    expect(summary.ownerClaimDropped).toBe(true);

    // The source is untouched.
    const original = new DatabaseSync(path.join(source, 'core.db'), { readOnly: true });
    expect(original.prepare('SELECT COUNT(*) AS n FROM scheduled_tasks WHERE enabled = 1').get()).toEqual({ n: 2 });
    expect(original.prepare("SELECT COUNT(*) AS n FROM core_metadata WHERE key = 'singleton_owner'").get()).toEqual({ n: 1 });
    original.close();
    expect(fs.existsSync(path.join(source, 'core.token'))).toBe(true);
  });

  it('refuses to write into a non-empty directory or inside the source profile', () => {
    const source = syntheticProfile();
    const busy = makeDir('pandesh-clone-busy-');
    fs.writeFileSync(path.join(busy, 'something.txt'), 'x');
    expect(() => cloneProfileForRehearsal({ from: source, to: busy })).toThrow(/not empty/);
    expect(() => cloneProfileForRehearsal({ from: source, to: path.join(source, 'nested') })).toThrow(/inside the source/);
  });
});
