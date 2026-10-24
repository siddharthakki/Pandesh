import * as crypto from 'crypto';
import * as path from 'path';

export interface ObservedFileVersion {
  path: string;
  hash: string;
  observedAt: string;
  taskId?: string;
  sessionId?: string;
}

export function hashText(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export class FileVersionTracker {
  private static readonly versions = new Map<string, ObservedFileVersion>();

  static record(
    filePath: string,
    content: string,
    identity?: { taskId?: string; sessionId?: string },
  ): ObservedFileVersion {
    const normalized = path.resolve(filePath);
    const version: ObservedFileVersion = {
      path: normalized,
      hash: hashText(content),
      observedAt: new Date().toISOString(),
      taskId: identity?.taskId,
      sessionId: identity?.sessionId,
    };
    this.versions.set(this.key(normalized, identity), version);
    return version;
  }

  static get(
    filePath: string,
    identity?: { taskId?: string; sessionId?: string },
  ): ObservedFileVersion | undefined {
    const normalized = path.resolve(filePath);
    const exact = this.versions.get(this.key(normalized, identity));
    if (exact) { return exact; }

    const candidates = [...this.versions.values()]
      .filter(version => version.path === normalized)
      .filter(version => !identity?.taskId || version.taskId === identity.taskId)
      .filter(version => !identity?.sessionId || version.sessionId === identity.sessionId)
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
    return candidates[0];
  }

  static clear(identity?: { taskId?: string; sessionId?: string }): void {
    if (!identity?.taskId && !identity?.sessionId) {
      this.versions.clear();
      return;
    }
    for (const [key, version] of this.versions.entries()) {
      if (identity.taskId && version.taskId !== identity.taskId) { continue; }
      if (identity.sessionId && version.sessionId !== identity.sessionId) { continue; }
      this.versions.delete(key);
    }
  }

  private static key(
    filePath: string,
    identity?: { taskId?: string; sessionId?: string },
  ): string {
    return `${identity?.taskId ?? ''}:${identity?.sessionId ?? ''}:${filePath}`;
  }
}
