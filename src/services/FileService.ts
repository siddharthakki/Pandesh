import * as fs from 'fs/promises';
import * as path from 'path';

export class FileService {
  static async readText(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf8');
  }

  static async writeText(filePath: string, content: string): Promise<number> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return Buffer.byteLength(content, 'utf8');
  }

  static async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  static async readLines(filePath: string, startLine: number, endLine: number): Promise<string[]> {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    return lines.slice(start, end);
  }

  static async listDir(
    dirPath: string,
    depth: number,
    ignoredDirs: string[],
    currentDepth = 0,
  ): Promise<string[]> {
    if (currentDepth >= depth) {
      return [];
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirs.includes(entry.name)) {
        continue;
      }
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(`${full}/`);
        const children = await this.listDir(full, depth, ignoredDirs, currentDepth + 1);
        results.push(...children);
      } else {
        results.push(full);
      }
    }

    return results;
  }

  static async createDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  static async copyFile(src: string, dest: string): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }

  static async deleteFile(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  static async sha256(filePath: string): Promise<string> {
    const { createHash } = await import('crypto');
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  }

  // Write to a .tmp file then atomically rename to ensure no partial-write corruption.
  static async atomicWriteText(filePath: string, content: string): Promise<void> {
    const tmpPath = filePath + '.tmp';
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
  }
}
