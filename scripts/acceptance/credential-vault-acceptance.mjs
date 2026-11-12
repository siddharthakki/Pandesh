#!/usr/bin/env node
/**
 * Live acceptance for persistent provider credentials (Windows only), with DUMMY keys in an isolated Credential
 * Manager namespace (`pandesh-acc*`), so a real `pandesh/...` credential is never read, written or deleted.
 * Every step runs in its own Node process; steps print booleans and hashes, never a key.
 *
 *   node scripts/acceptance/credential-vault-acceptance.mjs [evidenceDir]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const evidenceDir = path.resolve(process.argv[2] ?? 'D:/PandeshFreeModelsAcceptance');
const work = path.join(evidenceDir, 'vault');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const DUMMY = { groq: 'gsk_PANDESHDUMMYvaultacc000000000000000000001', openrouter: 'sk-or-v1-PANDESHDUMMYvaultacc0000000000000002' };
const PASS = 'acceptance passphrase 2026-11-12';
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const evidence = { startedAt: new Date().toISOString(), scenarios: {} };
const record = (id, pass, summary) => { evidence.scenarios[id] = { pass, summary }; console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${summary}`); };

// The vault code as shipped, bundled twice into two different folders: "install A" and a "fresh clone" B.
const bundle = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), path.join(root, 'apps/desktop/src/host/credentialVault.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${path.join(dir, 'vault.cjs')}`, '--log-level=error']);
  return path.join(dir, 'vault.cjs');
};
const installA = bundle(path.join(work, 'install-A'));
const cloneB = bundle(path.join(work, 'reclone-B'));

/** Runs one step in a fresh Node process. `code` gets `v` (the vault module) and must print JSON. */
function step(vaultPath, code, env = {}) {
  const script = `const v=require(${JSON.stringify(vaultPath)});(async()=>{${code}})().catch(e=>{console.log(JSON.stringify({error:String(e.message)}));process.exit(1)});`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  const out = (r.stdout || '').trim();
  for (const value of Object.values(DUMMY)) if (out.includes(value) || (r.stderr || '').includes(value)) throw new Error('KEY LEAK in step output');
  return JSON.parse(out || '{}');
}

const ns = 'pandesh-acc';
const ns2 = 'pandesh-acc-restore';
const realBefore = execFileSync('cmd.exe', ['/c', 'cmdkey /list'], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => /Target:.*\bpandesh\//.test(l)).length;
try {
  // 1. Save in "install A" (its own data dir).
  const dataA = path.join(work, 'data-A');
  const saved = step(installA, `const vault=new v.CredentialVault(${JSON.stringify(dataA)}, new v.WindowsCredentialBackend('${ns}'), ()=>null);
    await vault.set('groq', ${JSON.stringify(DUMMY.groq)}); await vault.set('openrouter', ${JSON.stringify(DUMMY.openrouter)});
    const s=await vault.status(['groq','openrouter','gemini']); console.log(JSON.stringify(s));`);
  record('SAVE', saved.groq.configured && saved.openrouter.configured && !saved.gemini.configured && saved.groq.source === 'credential-manager', `saved 2 dummy keys; status shows masked hints only (${saved.groq.hint}, ${saved.openrouter.hint}); unconfigured provider reports configured=false`);

  // 2. Restart: a new process, same install, reads them back (compared by hash inside the step).
  const reread = step(installA, `const vault=new v.CredentialVault(${JSON.stringify(dataA)}, new v.WindowsCredentialBackend('${ns}'), ()=>null);
    const k=await vault.get('groq'); console.log(JSON.stringify({ok: require('crypto').createHash('sha256').update(k||'').digest('hex').slice(0,16)}));`);
  record('RESTART', reread.ok === hash(DUMMY.groq), `new process read the key back (sha256 prefix ${reread.ok} matches)`);

  // 3. Reinstall / reclone: a different code copy, a different (empty) data dir, a new process.
  const dataB = path.join(work, 'data-B-fresh');
  const recloned = step(cloneB, `const vault=new v.CredentialVault(${JSON.stringify(dataB)}, new v.WindowsCredentialBackend('${ns}'), ()=>null);
    const s=await vault.status(['groq','openrouter']); const k=await vault.get('openrouter');
    console.log(JSON.stringify({groq:s.groq.configured, openrouter:s.openrouter.configured, h: require('crypto').createHash('sha256').update(k||'').digest('hex').slice(0,16)}));`);
  record('REINSTALL-RECLONE', recloned.groq && recloned.openrouter && recloned.h === hash(DUMMY.openrouter) && !fs.existsSync(path.join(dataB, 'cloud-provider-groq.credential.bin')), 'a separate code copy with an empty data dir sees both keys immediately; nothing was written into its data dir');

  // 4. Encrypted backup to the evidence drive (not the system drive).
  const backupFile = path.join(work, 'acceptance.pandesh-keys');
  const exported = step(installA, `const vault=new v.CredentialVault(${JSON.stringify(dataA)}, new v.WindowsCredentialBackend('${ns}'), ()=>null);
    console.log(JSON.stringify(await vault.exportBackup(${JSON.stringify(backupFile)}, ${JSON.stringify(PASS)}, ['groq','openrouter'])));`);
  const raw = fs.readFileSync(backupFile, 'utf8');
  const plaintextFree = !raw.includes(DUMMY.groq) && !raw.includes(DUMMY.openrouter) && !raw.includes('groq') && !raw.includes('openrouter');
  record('BACKUP', exported.providers?.length === 2 && plaintextFree && JSON.parse(raw).kdf.name === 'scrypt', `wrote ${path.basename(backupFile)} (${raw.length} bytes, scrypt N=2^17 + AES-256-GCM); no key or provider name in plaintext`);

  // 5. Restore without the original Windows profile: an empty fake profile (USERPROFILE/APPDATA/LOCALAPPDATA),
  //    no DPAPI, no Electron safeStorage, no data dir. Only the file + passphrase. Approved providers only.
  const fakeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-fresh-profile-'));
  const env = { USERPROFILE: fakeProfile, APPDATA: path.join(fakeProfile, 'Roaming'), LOCALAPPDATA: path.join(fakeProfile, 'Local'), HOME: fakeProfile };
  const wrong = step(cloneB, `try{await v.readEncryptedBackup(${JSON.stringify(backupFile)}, 'wrong passphrase here');console.log('{"opened":true}')}catch(e){console.log(JSON.stringify({opened:false,msg:e.message}))}`, env);
  const restored = step(cloneB, `const mem=new v.MemoryCredentialBackend(); const vault=new v.CredentialVault(${JSON.stringify(path.join(fakeProfile, 'data'))}, mem, ()=>null);
    const listed=await v.listBackupProviders(${JSON.stringify(backupFile)}, ${JSON.stringify(PASS)});
    const r=await vault.restoreBackup(${JSON.stringify(backupFile)}, ${JSON.stringify(PASS)}, ['groq']);
    console.log(JSON.stringify({listed, r, h: require('crypto').createHash('sha256').update(mem.values.get('groq')||'').digest('hex').slice(0,16), hasOR: mem.values.has('openrouter')}));`, env);
  record('RESTORE-NO-PROFILE', !wrong.opened && restored.r.restored.join() === 'groq' && restored.r.skipped.join() === 'openrouter' && restored.h === hash(DUMMY.groq) && !restored.hasOR,
    `in an empty fake profile: wrong passphrase refused ("${wrong.msg}"); backup lists ${restored.listed.join(', ')}; restored only the approved one (groq, hash matches), skipped openrouter`);

  // 6. Restore into a live Credential Manager namespace, then read it from yet another process.
  step(cloneB, `const vault=new v.CredentialVault(${JSON.stringify(path.join(work, 'data-C'))}, new v.WindowsCredentialBackend('${ns2}'), ()=>null);
    console.log(JSON.stringify(await vault.restoreBackup(${JSON.stringify(backupFile)}, ${JSON.stringify(PASS)}, ['groq','openrouter'])));`);
  const check = step(installA, `const vault=new v.CredentialVault(${JSON.stringify(path.join(work, 'data-D'))}, new v.WindowsCredentialBackend('${ns2}'), ()=>null);
    const s=await vault.status(['groq','openrouter']); console.log(JSON.stringify({g:s.groq.configured,o:s.openrouter.configured}));`);
  record('RESTORE-CREDMAN', check.g && check.o, 'restored both keys into Credential Manager; a separate process sees them');

  // 7. Legacy migration with read-back verification (fake safeStorage box; real Credential Manager).
  const dataL = path.join(work, 'data-legacy');
  fs.mkdirSync(dataL, { recursive: true });
  fs.writeFileSync(path.join(dataL, 'cloud-provider-groq.credential.bin'), Buffer.from(`enc:${Buffer.from(DUMMY.groq).toString('base64')}`));
  const box = `{isEncryptionAvailable:()=>true,encryptString:p=>Buffer.from('enc:'+Buffer.from(p).toString('base64')),decryptString:b=>Buffer.from(b.toString().slice(4),'base64').toString()}`;
  const migrated = step(installA, `const vault=new v.CredentialVault(${JSON.stringify(dataL)}, new v.WindowsCredentialBackend('${ns}-legacy'), ()=>(${box}));
    const before=(await vault.status(['groq'])).groq.source; const r=await vault.migrateLegacy(['groq']); vault.invalidate(); const after=(await vault.status(['groq'])).groq.source;
    console.log(JSON.stringify({before,r,after,kept: require('fs').existsSync(${JSON.stringify(path.join(dataL, 'cloud-provider-groq.credential.bin'))})}));`);
  record('MIGRATE-LEGACY', migrated.before === 'legacy-encrypted-file' && migrated.r[0].migrated && migrated.after === 'credential-manager' && migrated.kept, `legacy file → Credential Manager, verified by hash read-back; legacy file kept; output: ${JSON.stringify(migrated.r)}`);
} finally {
  // Clean up only the acceptance namespaces.
  for (const target of ['groq', 'openrouter']) {
    for (const space of [ns, ns2, `${ns}-legacy`]) spawnSync('cmd.exe', ['/c', `cmdkey /delete:${space}/${target}/api-key`], { encoding: 'utf8' });
  }
}
const left = execFileSync('cmd.exe', ['/c', 'cmdkey /list'], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => /Target:.*pandesh-acc/.test(l)).length;
const realAfter = execFileSync('cmd.exe', ['/c', 'cmdkey /list'], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => /Target:.*\bpandesh\//.test(l)).length;
record('CLEANUP', left === 0 && realBefore === realAfter, `acceptance credentials removed (${left} left); real pandesh/* credentials untouched (${realBefore} before, ${realAfter} after)`);
evidence.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(evidenceDir, 'credential-acceptance.json'), JSON.stringify(evidence, null, 2));
process.exit(Object.values(evidence.scenarios).every((s) => s.pass) ? 0 : 1);
