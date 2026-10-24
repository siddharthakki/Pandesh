import * as fs from 'fs/promises';
import * as path from 'path';
import { MemoryRecord } from './MemoryTypes';

export interface MemoryStorage {
  load(): Promise<MemoryRecord[]>;
  save(records: MemoryRecord[]): Promise<void>;
}

export class FileMemoryStorage implements MemoryStorage {
  constructor(private readonly filename: string) {}

  async load(): Promise<MemoryRecord[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('Memory storage must contain an array.');
      return parsed as MemoryRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(records: MemoryRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filename);
  }
}

export class InMemoryMemoryStorage implements MemoryStorage {
  private records: MemoryRecord[] = [];

  async load(): Promise<MemoryRecord[]> {
    return clone(this.records);
  }

  async save(records: MemoryRecord[]): Promise<void> {
    this.records = clone(records);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
