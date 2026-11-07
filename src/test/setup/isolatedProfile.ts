/**
 * Tests never touch the real user profile (Build 159 audit, auditor incident 1).
 *
 * A unit test that constructed EverydayTimerManager with the wrong option shape fell back to the production default
 * %LOCALAPPDATA%\KarkeDikha\desktop\timers.json and wrote a fake running timer into the user's real timers. Every
 * production default path in Pandesh is derived from LOCALAPPDATA / APPDATA / KARKEDIKHA_DATA_DIR, so this setup file
 * points all three at a per-worker scratch profile before any test module is imported. A test that forgets to pass its
 * own directory now writes into scratch, never into the user's data. Child processes spawned with `...process.env`
 * inherit the scratch profile too.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REAL = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  APPDATA: process.env.APPDATA,
  KARKEDIKHA_DATA_DIR: process.env.KARKEDIKHA_DATA_DIR,
};

if (!process.env.PANDESH_TEST_PROFILE_ROOT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pandesh-test-profile-${process.pid}-`));
  const local = path.join(root, 'Local');
  const roaming = path.join(root, 'Roaming');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });
  process.env.PANDESH_TEST_PROFILE_ROOT = root;
  process.env.PANDESH_REAL_LOCALAPPDATA = REAL.LOCALAPPDATA ?? '';
  process.env.LOCALAPPDATA = local;
  process.env.APPDATA = roaming;
  process.env.KARKEDIKHA_DATA_DIR = path.join(local, 'KarkeDikha');
}
