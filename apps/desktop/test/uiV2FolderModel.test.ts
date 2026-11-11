import { describe, expect, it } from 'vitest';
import {
  accessSentence, folderChip, folderName, grantNote, proposalActions, proposalFor, proposalProblem, recentChoices,
  type FolderCheck, type WorkspaceView,
} from '../renderer-v2/src/folderModel';

const ok = (folder: string, extra: Partial<FolderCheck> = {}): FolderCheck => ({ folder, state: 'ok', readable: true, writable: true, ...extra });
const ws = (folder: string, access: WorkspaceView['access'], source: WorkspaceView['source'] = 'picker'): WorkspaceView => ({ folder, access, grantedAt: null, source });

describe('v2 folder chip and menu', () => {
  it('names the folder by its last part, a drive by its letter, and says when it is read-only', () => {
    expect(folderName('C:\\Projects\\site-builder')).toBe('site-builder');
    expect(folderName('D:\\Notes\\')).toBe('Notes');
    expect(folderName('D:\\')).toBe('D:');
    expect(folderChip(null)).toMatchObject({ label: 'No folder', readOnly: false });
    expect(folderChip(ws('C:\\Projects\\site-builder', 'read'))).toMatchObject({ label: 'site-builder · read only', readOnly: true });
    expect(folderChip(ws('C:\\Projects\\site-builder', 'read_write')).title).toBe('Workspace: C:\\Projects\\site-builder (read and write). Click to change.');
  });

  it('describes each access level in plain words, and where an inherited one came from', () => {
    expect(accessSentence('read')).toMatch(/does not change anything/);
    expect(accessSentence('read_write')).toMatch(/approval first/);
    expect(grantNote(ws('C:\\x', 'read_write', 'earlier_build'))).toMatch(/earlier version/);
    expect(grantNote(ws('C:\\x', 'read', 'chat'))).toBeNull();
  });

  it('lists recent folders without the current one', () => {
    const recent = [{ folder: 'C:\\A', access: 'read' as const, lastUsedAt: '' }, { folder: 'c:\\b\\', access: 'read_write' as const, lastUsedAt: '' }];
    expect(recentChoices(recent, ws('C:\\B', 'read')).map((r) => r.folder)).toEqual(['C:\\A']);
    expect(recentChoices(undefined, null)).toEqual([]);
  });
});

describe('v2 card that asks before a folder becomes the workspace', () => {
  it('asks for Read and, unless this folder had it before, leaves Write off', () => {
    expect(proposalFor(ok('D:\\Site'), 'chat', null, { message: 'check D:\\Site' })).toMatchObject({ read: true, write: false, message: 'check D:\\Site', source: 'chat' });
    expect(proposalFor(ok('D:\\Site'), 'recent', 'read_write')).toMatchObject({ read: true, write: true });
    expect(proposalFor(ok('D:\\Site'), 'picker', 'read')).toMatchObject({ write: false });
  });

  it('sends a held message with or without the folder, or gives it back to edit', () => {
    expect(proposalActions(proposalFor(ok('D:\\Site'), 'chat', null, { message: 'hi' }))).toEqual({ use: 'Use this folder and send', skip: 'Send without it', cancel: 'Edit message' });
    expect(proposalActions(proposalFor(ok('D:\\Site'), 'picker', null))).toEqual({ use: 'Use this folder', skip: null, cancel: 'Cancel' });
    const refused = { folder: 'C:\\Windows', state: 'refused' as const, reason: 'this is a Windows system folder', readable: false, writable: false };
    expect(proposalActions(proposalFor(refused, 'chat', null, { message: 'look at C:\\Windows' }))).toEqual({ use: '', skip: 'Send without it', cancel: 'Edit message' });
    expect(proposalActions(proposalFor(refused, 'picker', null))).toEqual({ use: '', skip: null, cancel: 'OK' });
  });

  it('will not use a folder without Read, or one Pandesh cannot use', () => {
    const p = proposalFor(ok('D:\\Site'), 'picker', null);
    expect(proposalProblem(p)).toBeNull();
    expect(proposalProblem({ ...p, read: false })).toMatch(/needs Read/);
    expect(proposalProblem(proposalFor({ ...ok('D:\\x'), state: 'missing', reason: 'this folder does not exist on this PC' }, 'picker', null))).toBe('this folder does not exist on this PC');
  });
});
