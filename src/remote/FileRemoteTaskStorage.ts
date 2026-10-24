import * as fs from 'fs/promises';
import * as path from 'path';
import { RemoteDevice, RemoteMessage, RemoteTaskStorage } from './RemoteTaskService';

interface RemoteState {
  schemaVersion: 1;
  devices: RemoteDevice[];
  messages: RemoteMessage[];
}

export class FileRemoteTaskStorage implements RemoteTaskStorage {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  async loadDevices(): Promise<RemoteDevice[]> {
    await this.queue;
    return (await this.load()).devices;
  }

  async loadMessages(): Promise<RemoteMessage[]> {
    await this.queue;
    return (await this.load()).messages;
  }

  saveDevices(devices: RemoteDevice[]): Promise<void> {
    return this.update(state => ({ ...state, devices: clone(devices) }));
  }

  saveMessages(messages: RemoteMessage[]): Promise<void> {
    return this.update(state => ({ ...state, messages: clone(messages) }));
  }

  private update(mutator: (state: RemoteState) => RemoteState): Promise<void> {
    const next = this.queue.then(async () => {
      const current = await this.load();
      await this.save(mutator(current));
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<RemoteState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, 'utf8')) as RemoteState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.devices) || !Array.isArray(parsed.messages)) {
        throw new Error('Remote task state has an unsupported format.');
      }
      return clone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, devices: [], messages: [] };
      }
      throw error;
    }
  }

  private async save(state: RemoteState): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filename);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
