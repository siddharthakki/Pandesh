import * as fs from 'fs';
import * as path from 'path';

export interface RepositorySnapshot {
  rootPath: string;
  generatedAt: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown';
  projectType: 'typescript' | 'javascript' | 'unknown';
  hasGit: boolean;
  keyFiles: string[];
  sourceDirectories: string[];
  validationCommands: string[];
}

function exists(rootPath: string, relativePath: string): boolean {
  return fs.existsSync(path.join(rootPath, relativePath));
}

export function createRepositorySnapshot(rootPath: string): RepositorySnapshot {
  const hasPackageJson = exists(rootPath, 'package.json');

  const packageManager = exists(rootPath, 'pnpm-lock.yaml')
    ? 'pnpm'
    : exists(rootPath, 'yarn.lock')
      ? 'yarn'
      : exists(rootPath, 'package-lock.json')
        ? 'npm'
        : 'unknown';

  const projectType =
    exists(rootPath, 'tsconfig.json') ? 'typescript' :
    hasPackageJson ? 'javascript' :
    'unknown';

  const keyFiles = [
    'package.json',
    'tsconfig.json',
    'src/extension.ts',
    'src/agent/AgentLoop.ts',
    'src/tools/ToolExecutor.ts',
    'src/policy/PolicyEngine.ts',
    'README.md'
  ].filter(file => exists(rootPath, file));

  const sourceDirectories = [
    'src',
    'src/agent',
    'src/tools',
    'src/policy',
    'src/ui',
    'test',
    'tests'
  ].filter(dir => exists(rootPath, dir));

  const validationCommands =
    packageManager === 'npm'
      ? ['npm run compile']
      : packageManager === 'pnpm'
        ? ['pnpm compile']
        : packageManager === 'yarn'
          ? ['yarn compile']
          : [];

  return {
    rootPath,
    generatedAt: new Date().toISOString(),
    packageManager,
    projectType,
    hasGit: exists(rootPath, '.git'),
    keyFiles,
    sourceDirectories,
    validationCommands
  };
}

export function writeRepositorySnapshot(rootPath: string): string {
  const snapshot = createRepositorySnapshot(rootPath);
  const outputDir = path.join(rootPath, '.ollama-agent');
  const outputPath = path.join(outputDir, 'repository-snapshot.json');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  return outputPath;
}