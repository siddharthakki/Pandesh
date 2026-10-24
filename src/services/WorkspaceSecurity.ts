import * as path from 'path';
import * as fs from 'fs/promises';

// Files that must never be written by the agent regardless of workspace settings.
const PROTECTED_PATTERNS: RegExp[] = [
  /^\.env(\.|$)/i,           // .env, .env.local, .env.production, etc.
  /\.env$/i,                  // anything ending in .env
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^credentials\.(json|yaml|yml)$/i,
  /^secrets\.(json|yaml|yml)$/i,
];

async function canonicalizePotentialPath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const realAncestor = await fs.realpath(cursor);
      return missingSegments.length > 0
        ? path.join(realAncestor, ...missingSegments.reverse())
        : realAncestor;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return path.normalize(candidate);
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export class WorkspaceSecurity {
  static isProtectedPath(requestedPath: string): boolean {
    const basename = path.basename(requestedPath);
    return PROTECTED_PATTERNS.some((p) => p.test(basename));
  }

  static async resolveInsideWorkspace(
    requestedPath: string,
    workspaceRoot: string,
    allowOutside: boolean,
  ): Promise<string> {
    const resolved = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(workspaceRoot, requestedPath);

    if (allowOutside) {
      return resolved;
    }

    const realRoot = await canonicalizePotentialPath(workspaceRoot);
    const realResolved = await canonicalizePotentialPath(resolved);

    // path.relative is platform-aware. On Windows it handles drive-letter and
    // path casing correctly, unlike a case-sensitive startsWith comparison.
    const relative = path.relative(realRoot, realResolved);
    const isOutside = relative.startsWith('..') || path.isAbsolute(relative);

    if (isOutside) {
      throw new Error(
        `Path "${requestedPath}" resolves outside workspace root "${workspaceRoot}". ` +
          `Set ollama-agent.allowOutsideWorkspace to true to permit this.`,
      );
    }

    return realResolved;
  }

  static async ensureInsideWorkspace(
    requestedPath: string,
    workspaceRoot: string,
    allowOutside: boolean,
  ): Promise<string> {
    return this.resolveInsideWorkspace(requestedPath, workspaceRoot, allowOutside);
  }
}
