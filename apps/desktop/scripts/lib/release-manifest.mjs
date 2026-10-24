/**
 * Release manifest (build-fingerprint.json) shared by package-portable.mjs, package-installer.mjs and the
 * Windows Sandbox smoke test.
 *
 * The manifest is derived from the files that are actually in the packaged tree, after it is built. It is never
 * a snapshot taken before a rebuild. A missing mandatory file is an error, and a working tree with tracked
 * source changes is recorded as `dirty` (and refused unless explicitly allowed) so it can never be presented
 * as a clean build of the recorded commit.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MANIFEST_FILE = 'build-fingerprint.json';
export const MANIFEST_SCHEMA = 3;

/** Packaged-tree-relative files that must exist and be hashed in every release. */
export const MANDATORY_BUNDLE_FILES = {
  coreBundle: 'runtime/core.js',
  nodeRuntime: 'runtime/node.exe',
  mainBundle: 'app/out/main.js',
  preloadBundle: 'app/out/preload.js',
  rendererHtml: 'app/renderer/index.html',
  rendererScript: 'app/renderer/renderer.js',
  appPackageJson: 'app/package.json',
  electronExe: 'electron/electron.exe',
  piAgentCore: 'runtime/node_modules/@earendil-works/pi-agent-core/package.json',
  piAi: 'runtime/node_modules/@earendil-works/pi-ai/package.json',
  whisperConfig: 'models/whisper-base-en/Xenova/whisper-base.en/config.json',
  asrTransformers: 'runtime-assets/node_modules/@xenova/transformers/package.json',
  // The embedded version/build identity. It is hashed like every other
  // shipped file, so a build that shows one version in the UI and ships
  // another cannot pass the manifest check.
  buildIdentity: 'build-identity.json',
};

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toUpperCase();
}

function git(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

/** Source pathspecs that can change a shipped binary. Generated output (dist, out, out-core) is ignored by git. */
const SOURCE_PATHSPEC = ['core', 'apps', 'scripts', 'src', 'package.json', 'package-lock.json', 'esbuild.core.js'];

export function gitSourceState(repoRoot) {
  const commit = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=normal', '--', ...SOURCE_PATHSPEC])
    .split(/\r?\n/).filter(Boolean);
  const dirty = status.length > 0;
  const diffSha256 = dirty
    ? crypto.createHash('sha256').update(git(repoRoot, ['diff', 'HEAD', '--', ...SOURCE_PATHSPEC])).digest('hex').toUpperCase()
    : null;
  return { commit, sourceState: dirty ? 'dirty' : 'clean', dirtyFiles: status, diffSha256 };
}

/** The embedded build identity. A malformed file is a packaging error, not a warning. */
function readBuildIdentityOrThrow(packagedRoot) {
  const file = path.join(packagedRoot, 'build-identity.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`build identity is not valid JSON (${file}): ${err.message}`);
  }
}

function hashMandatoryFiles(root) {  const files = {};
  const missing = [];
  for (const [name, rel] of Object.entries(MANDATORY_BUNDLE_FILES)) {
    const full = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { missing.push(rel); continue; }
    files[name] = { path: rel, bytes: fs.statSync(full).size, sha256: sha256File(full) };
  }
  if (missing.length) throw new Error(`mandatory bundle files missing from ${root}: ${missing.join(', ')}`);
  return files;
}

/** Builds the manifest from the packaged tree itself. Throws when a mandatory file is missing, or the tree is dirty. */
export function buildReleaseManifest(packagedRoot, repoRoot, { allowDirty = process.env.KARKEDIKHA_ALLOW_DIRTY_BUILD === '1' } = {}) {
  const source = gitSourceState(repoRoot);
  if (source.sourceState === 'dirty' && !allowDirty) {
    throw new Error(
      `refusing to package a dirty working tree as commit ${source.commit}. Commit or stash these changes, or set `
      + `KARKEDIKHA_ALLOW_DIRTY_BUILD=1 to record an explicitly dirty build:\n  ${source.dirtyFiles.join('\n  ')}`,
    );
  }
  return {
    schema: MANIFEST_SCHEMA,
    builtAt: new Date().toISOString(),
    ...source,
    // The build identity is carried in the manifest as well as in its own
    // hashed file, so the release manifest, the installer metadata and the
    // version the app displays cannot disagree.
    ...(fs.existsSync(path.join(packagedRoot, 'build-identity.json'))
      ? { buildIdentity: readBuildIdentityOrThrow(packagedRoot) }
      : {}),
    files: hashMandatoryFiles(packagedRoot),
  };
}

export function writeReleaseManifest(packagedRoot, manifest) {
  fs.writeFileSync(path.join(packagedRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readReleaseManifest(packagedRoot) {
  const file = path.join(packagedRoot, MANIFEST_FILE);
  if (!fs.existsSync(file)) throw new Error(`release manifest missing: ${file}`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`release manifest schema ${manifest.schema} != ${MANIFEST_SCHEMA}: ${file}`);
  return manifest;
}

/** Re-hashes the packaged tree and fails on any missing file or digest drift against the recorded manifest. */
export function verifyReleaseManifest(packagedRoot, manifest = readReleaseManifest(packagedRoot)) {
  const actual = hashMandatoryFiles(packagedRoot);
  const problems = [];
  for (const name of Object.keys(MANDATORY_BUNDLE_FILES)) {
    if (!manifest.files?.[name]?.sha256) problems.push(`manifest has no hash for ${name}`);
    else if (manifest.files[name].sha256 !== actual[name].sha256) problems.push(`${name} (${actual[name].path}) hash differs from manifest`);
  }
  if (problems.length) throw new Error(`release manifest does not match ${packagedRoot}: ${problems.join('; ')}`);
  return manifest;
}
