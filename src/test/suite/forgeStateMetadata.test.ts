import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Forge repository state metadata', () => {
  it('parses as UTF-8 JSON without stripping a BOM', () => {
    const statePath = path.resolve(__dirname, '..', '..', '..', '.forge', 'state.json');
    const raw = fs.readFileSync(statePath, 'utf8');

    expect(raw.charCodeAt(0)).not.toBe(0xFEFF);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
