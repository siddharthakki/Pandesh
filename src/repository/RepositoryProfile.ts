import * as fs from 'fs';
import * as path from 'path';
import { createRepositorySnapshot, RepositorySnapshot } from './RepositorySnapshot';

export interface PackageScript {
  name: string;
  command: string;
}

export interface RepositoryProfile {
  snapshot: RepositorySnapshot;
  packageName: string | null;
  packageVersion: string | null;
  scripts: PackageScript[];
  detectedCommands: {
    build: string[];
    test: string[];
    lint: string[];
    compile: string[];
  };
  likelyEntryPoints: string[];
}

interface PackageJson {
  name?: unknown;
  version?: unknown;
  scripts?: unknown;
}

function readPackageJson(rootPath: string): PackageJson | null {
  const packageJsonPath = path.join(rootPath, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

function getScripts(packageJson: PackageJson | null): PackageScript[] {
  if (!packageJson || typeof packageJson.scripts !== 'object' || packageJson.scripts === null) {
    return [];
  }

  return Object.entries(packageJson.scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, command]) => ({ name, command }));
}

function findScripts(scripts: PackageScript[], names: string[]): string[] {
  const wanted = new Set(names);
  return scripts
    .filter(script => wanted.has(script.name))
    .map(script => `npm run ${script.name}`);
}

function detectLikelyEntryPoints(rootPath: string): string[] {
  const candidates = [
    'src/extension.ts',
    'src/index.ts',
    'src/main.ts',
    'src/app.ts',
    'index.ts',
    'main.ts'
  ];

  return candidates.filter(candidate => fs.existsSync(path.join(rootPath, candidate)));
}

export function createRepositoryProfile(rootPath: string): RepositoryProfile {
  const snapshot = createRepositorySnapshot(rootPath);
  const packageJson = readPackageJson(rootPath);
  const scripts = getScripts(packageJson);

  return {
    snapshot,
    packageName: typeof packageJson?.name === 'string' ? packageJson.name : null,
    packageVersion: typeof packageJson?.version === 'string' ? packageJson.version : null,
    scripts,
    detectedCommands: {
      build: findScripts(scripts, ['build']),
      test: findScripts(scripts, ['test']),
      lint: findScripts(scripts, ['lint']),
      compile: findScripts(scripts, ['compile'])
    },
    likelyEntryPoints: detectLikelyEntryPoints(rootPath)
  };
}

export function writeRepositoryProfile(rootPath: string): string {
  const profile = createRepositoryProfile(rootPath);
  const outputDir = path.join(rootPath, '.ollama-agent');
  const outputPath = path.join(outputDir, 'repository-profile.json');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');

  return outputPath;
}