/**
 * M1 / F03: pc_organize_apply used to report success when it moved nothing, so a turn whose files were all still in place
 * ended `completed`/`satisfied`. An apply that moved nothing is "NOT DONE"; a real apply, and an apply of a plan that was
 * already fully applied, are not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createPcOrganizerAdapter, proposeOrganization } from '../runtime/pcOrganizer';
import { moveCounts } from '../domain/fileOrganization';
import { evaluateTurnOutcome } from '../runtime/turnOutcome';

let dir: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-apply-')); ({ db } = openCoreDatabase(path.join(dir, 'core.db'))); });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const text = (r: { output?: string }) => r.output ?? '';

describe('pc_organize_apply moving nothing', () => {
  it('reports NOT DONE (and the turn is judged unverified), while a real apply and a repeat of it succeed', async () => {
    const root = path.join(dir, 'messy'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'a.pdf'), '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'); fs.writeFileSync(path.join(root, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
    const adapter = createPcOrganizerAdapter({ db });
    const plan = await proposeOrganization(db, { roots: [root], targetBase: path.join(dir, 'sorted') });
    const call = (args: Record<string, unknown>) => adapter.run({ name: 'pc_organize_apply', arguments: args } as any);

    // a category filter that matches no move: nothing moved, files still in place
    const none = await call({ planId: plan.id, categories: ['no-such-category'] });
    expect(text(none as any)).toMatch(/NOT DONE \(nothing_moved\)/);
    expect((none as any).status).toBe('failed');
    expect(fs.existsSync(path.join(root, 'a.pdf'))).toBe(true);
    const outcome = evaluateTurnOutcome([{ tool: 'pc_organize_apply', status: 'completed', result: { isError: true, content: [{ type: 'text', text: text(none as any) }] } } as any]);
    expect(outcome.verdict).toBe('unverified');

    const real = await call({ planId: plan.id });
    if ((real as any).status !== "succeeded") console.log("REAL:", (real as any).output); expect((real as any).status).toBe("succeeded");
    expect(fs.existsSync(path.join(root, 'b.jpg'))).toBe(false);

    // applying a plan that is already fully applied is not a failure
    const again = await call({ planId: plan.id });
    if ((again as any).status !== "succeeded") console.log("AGAIN:", (again as any).output); expect((again as any).status).toBe("succeeded");
  });
});
