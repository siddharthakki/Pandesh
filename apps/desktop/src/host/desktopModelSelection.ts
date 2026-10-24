import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DesktopSelectedModel {
  model: string;
  updatedAt: string;
}

export function selectedModelFile(dataDir: string): string {
  return path.join(dataDir, 'selected-model.json');
}

export function readSelectedModel(dataDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(selectedModelFile(dataDir), 'utf8')) as DesktopSelectedModel;
    if (typeof raw.model === 'string' && raw.model.trim()) return raw.model.trim();
  } catch {
    // missing selection is fine
  }
  return null;
}

export function writeSelectedModel(dataDir: string, model: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(selectedModelFile(dataDir), `${JSON.stringify({
    model: model.trim(),
    updatedAt: new Date().toISOString(),
  } satisfies DesktopSelectedModel, null, 2)}\n`, 'utf8');
}
